use std::{borrow::Cow, collections::BTreeMap};

use g_code::{command, emit::Token};
use i_overlay::{
    core::fill_rule::FillRule as OverlayFillRule,
    float::simplify::SimplifyShape,
    mesh::{
        outline::offset::OutlineOffset,
        style::{LineJoin, OutlineStyle},
    },
};
use lyon_geom::{
    CubicBezierSegment, LineSegment, Point, QuadraticBezierSegment, SvgArc, Vector,
    euclid::default::Transform2D,
};
use roxmltree::Document;
use svgtypes::{Length, LengthUnit};
use uom::si::{
    f64::Length as UomLength,
    length::{inch, millimeter},
};

use super::{ConversionConfig, ConversionOptions, ConversionVisitor, visit};
use crate::{
    EngravingConfig, EngravingOperation, FillMode, GenerationWarning, Machine, Turtle,
    arc::{ArcOrLineSegment, FlattenWithArcs},
    converter::{selector::SelectorList, units::CSS_DEFAULT_DPI},
    turtle::{PaintStyle, SvgFillRule},
};

type Contour = Vec<[f64; 2]>;
type Shape = Vec<Contour>;

#[derive(Debug, Clone)]
struct FillNode {
    fill_rule: SvgFillRule,
    contours: Vec<Contour>,
}

#[derive(Debug, Clone)]
struct StrokeSubpath {
    segments: Vec<ArcOrLineSegment<f64>>,
}

#[derive(Debug, Clone)]
struct Toolpath {
    segments: Vec<ArcOrLineSegment<f64>>,
    depth: f64,
    target_depth: f64,
}

fn segment_from(seg: &ArcOrLineSegment<f64>) -> Point<f64> {
    match seg {
        ArcOrLineSegment::Arc(a) => a.from,
        ArcOrLineSegment::Line(l) => l.from,
    }
}

fn segment_to(seg: &ArcOrLineSegment<f64>) -> Point<f64> {
    match seg {
        ArcOrLineSegment::Arc(a) => a.to,
        ArcOrLineSegment::Line(l) => l.to,
    }
}

fn translate_segment(seg: &mut ArcOrLineSegment<f64>, offset: Vector<f64>) {
    match seg {
        ArcOrLineSegment::Arc(a) => {
            a.from += offset;
            a.to += offset;
        }
        ArcOrLineSegment::Line(l) => {
            l.from += offset;
            l.to += offset;
        }
    }
}

fn reverse_segment(seg: &mut ArcOrLineSegment<f64>) {
    match seg {
        ArcOrLineSegment::Arc(a) => {
            std::mem::swap(&mut a.from, &mut a.to);
            a.flags.sweep = !a.flags.sweep;
        }
        ArcOrLineSegment::Line(l) => {
            std::mem::swap(&mut l.from, &mut l.to);
        }
    }
}

impl Toolpath {
    fn start(&self) -> Point<f64> {
        segment_from(self.segments.first().expect("Toolpath must have at least one segment"))
    }

    fn end(&self) -> Point<f64> {
        segment_to(self.segments.last().expect("Toolpath must have at least one segment"))
    }

    fn translate(&mut self, offset: Vector<f64>) {
        for seg in &mut self.segments {
            translate_segment(seg, offset);
        }
    }

    fn reverse(&mut self) {
        self.segments.reverse();
        for seg in &mut self.segments {
            reverse_segment(seg);
        }
    }

    /// Iterate a coarse set of sample points covering the path for bounding
    /// box calculations. Arcs are sampled so bulges aren't missed.
    fn bounds_sample_points(&self) -> impl Iterator<Item = Point<f64>> + '_ {
        self.segments.iter().flat_map(|seg| {
            let mut pts: Vec<Point<f64>> = Vec::new();
            match seg {
                ArcOrLineSegment::Arc(a) => {
                    let arc = a.to_arc();
                    pts.push(a.from);
                    for i in 1..8 {
                        let t = i as f64 / 8.0;
                        pts.push(arc.sample(t));
                    }
                    pts.push(a.to);
                }
                ArcOrLineSegment::Line(l) => {
                    pts.push(l.from);
                    pts.push(l.to);
                }
            }
            pts.into_iter()
        })
    }
}

#[derive(Debug, Clone)]
struct OperationGroup {
    paths: Vec<Toolpath>,
    reversible: bool,
}

#[derive(Debug, Clone)]
struct ScheduledOperationGroup {
    operation_id: String,
    operation_name: String,
    group: OperationGroup,
}

#[derive(Debug)]
struct CamTurtle {
    tolerance: f64,
    circular_interpolation: bool,
    current_paint: PaintStyle,
    /// Flat point list — kept for fill-contour collection which always needs
    /// a polygon regardless of circular interpolation.
    current_points: Vec<Point<f64>>,
    /// Arc-aware segment list mirroring `current_points` — used for stroke
    /// output so arcs/Beziers survive the trip through the CAM pipeline.
    current_segments: Vec<ArcOrLineSegment<f64>>,
    pending_fill_contours: Vec<Contour>,
    fill_nodes: Vec<FillNode>,
    stroke_paths: Vec<StrokeSubpath>,
}

impl CamTurtle {
    fn new(tolerance: f64, circular_interpolation: bool) -> Self {
        Self {
            tolerance,
            circular_interpolation,
            current_paint: PaintStyle::default(),
            current_points: vec![],
            current_segments: vec![],
            pending_fill_contours: vec![],
            fill_nodes: vec![],
            stroke_paths: vec![],
        }
    }

    /// Append a linear segment, keeping `current_points` and
    /// `current_segments` in sync and coalescing zero-length segments.
    fn push_line_to(&mut self, to: Point<f64>) {
        let from = match self.current_points.last().copied() {
            Some(prev) if prev == to => return,
            Some(prev) => prev,
            None => to,
        };
        self.current_points.push(to);
        if from != to {
            self.current_segments
                .push(ArcOrLineSegment::Line(LineSegment { from, to }));
        }
    }

    /// Append a segment list from an arc or Bezier that has been
    /// arc-fitted by [`FlattenWithArcs`]. Also appends the resulting
    /// endpoints to `current_points` for fill contour collection.
    fn push_fitted_segments(&mut self, fitted: Vec<ArcOrLineSegment<f64>>) {
        for seg in fitted {
            let to = segment_to(&seg);
            if self.current_points.last().copied() != Some(to) {
                self.current_points.push(to);
            }
            self.current_segments.push(seg);
        }
    }

    fn flush_subpath(&mut self) {
        if self.current_points.len() < 2 {
            self.current_points.clear();
            self.current_segments.clear();
            return;
        }

        let closed = self
            .current_points
            .first()
            .zip(self.current_points.last())
            .is_some_and(|(first, last)| (*first - *last).square_length() < 1.0e-9);

        if self.current_paint.stroke && !self.current_segments.is_empty() {
            self.stroke_paths.push(StrokeSubpath {
                segments: self.current_segments.clone(),
            });
        }

        if self.current_paint.fill && closed {
            let mut contour = self
                .current_points
                .iter()
                .map(|point| [point.x, point.y])
                .collect::<Contour>();
            contour.pop();
            if contour.len() >= 3 {
                self.pending_fill_contours.push(contour);
            }
        }

        self.current_points.clear();
        self.current_segments.clear();
    }

    fn flush_fill_node(&mut self) {
        if self.current_paint.fill && !self.pending_fill_contours.is_empty() {
            self.fill_nodes.push(FillNode {
                fill_rule: self.current_paint.fill_rule,
                contours: std::mem::take(&mut self.pending_fill_contours),
            });
        } else {
            self.pending_fill_contours.clear();
        }
    }
}

impl Turtle for CamTurtle {
    fn begin(&mut self) {}

    fn end(&mut self) {
        self.flush_subpath();
        self.flush_fill_node();
    }

    fn set_paint_style(&mut self, style: PaintStyle) {
        self.current_paint = style;
    }

    fn comment(&mut self, _comment: String) {
        self.flush_subpath();
        self.flush_fill_node();
    }

    fn move_to(&mut self, to: Point<f64>) {
        self.flush_subpath();
        self.current_points.push(to);
    }

    fn line_to(&mut self, to: Point<f64>) {
        self.push_line_to(to);
    }

    fn arc(&mut self, svg_arc: SvgArc<f64>) {
        if svg_arc.is_straight_line() {
            self.push_line_to(svg_arc.to);
            return;
        }
        if self.circular_interpolation {
            let fitted = FlattenWithArcs::flattened(&svg_arc, self.tolerance);
            self.push_fitted_segments(fitted);
        } else {
            svg_arc
                .to_arc()
                .flattened(self.tolerance)
                .for_each(|point| self.push_line_to(point));
        }
    }

    fn cubic_bezier(&mut self, cbs: CubicBezierSegment<f64>) {
        if self.circular_interpolation {
            let fitted = FlattenWithArcs::<f64>::flattened(&cbs, self.tolerance);
            self.push_fitted_segments(fitted);
        } else {
            cbs.flattened(self.tolerance)
                .for_each(|point| self.push_line_to(point));
        }
    }

    fn quadratic_bezier(&mut self, qbs: QuadraticBezierSegment<f64>) {
        self.cubic_bezier(qbs.to_cubic());
    }
}

fn overlay_fill_rule(fill_rule: SvgFillRule) -> OverlayFillRule {
    match fill_rule {
        SvgFillRule::EvenOdd => OverlayFillRule::EvenOdd,
        SvgFillRule::NonZero => OverlayFillRule::NonZero,
    }
}

fn simplify_fill_nodes(nodes: Vec<FillNode>) -> Vec<Shape> {
    let mut grouped = BTreeMap::<SvgFillRule, Vec<Contour>>::new();
    for node in nodes {
        grouped
            .entry(node.fill_rule)
            .or_default()
            .extend(node.contours);
    }

    let mut shapes = vec![];
    for (fill_rule, contours) in grouped {
        shapes.extend(contours.simplify_shape(overlay_fill_rule(fill_rule)));
    }
    shapes
}

fn inset_shapes(shapes: &[Shape], delta: f64) -> Vec<Shape> {
    let style = OutlineStyle::new(-delta).line_join(LineJoin::Miter(2.0));
    let mut inset = vec![];
    for shape in shapes {
        inset.extend(shape.outline(&style));
    }
    inset
}

fn contour_to_points(contour: &Contour) -> Vec<Point<f64>> {
    contour.iter().map(|p| Point::new(p[0], p[1])).collect()
}

fn polyline_to_line_segments(points: &[Point<f64>]) -> Vec<ArcOrLineSegment<f64>> {
    points
        .windows(2)
        .filter(|w| w[0] != w[1])
        .map(|w| ArcOrLineSegment::Line(LineSegment { from: w[0], to: w[1] }))
        .collect()
}

fn normalize_or_none(v: Vector<f64>) -> Option<Vector<f64>> {
    let len = v.length();
    if !len.is_finite() || len < 1.0e-12 {
        None
    } else {
        Some(v / len)
    }
}

/// Fit a circle through three points. Returns `(center, radius)` or `None`
/// if the points are (nearly) collinear.
fn fit_circle_through_three(
    a: Point<f64>,
    b: Point<f64>,
    c: Point<f64>,
) -> Option<(Point<f64>, f64)> {
    let d = 2.0 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if d.abs() < 1.0e-12 {
        return None;
    }
    let a_sq = a.x * a.x + a.y * a.y;
    let b_sq = b.x * b.x + b.y * b.y;
    let c_sq = c.x * c.x + c.y * c.y;
    let ux = (a_sq * (b.y - c.y) + b_sq * (c.y - a.y) + c_sq * (a.y - b.y)) / d;
    let uy = (a_sq * (c.x - b.x) + b_sq * (a.x - c.x) + c_sq * (b.x - a.x)) / d;
    let center = Point::new(ux, uy);
    let radius = (a - center).length();
    if !radius.is_finite() || radius <= 0.0 {
        return None;
    }
    Some((center, radius))
}

/// Estimate the tangent direction at `points[0]`. First-edge chord direction
/// is 1st-order accurate and produces wrong-radius fits on smooth curves; we
/// prefer a 3-point circle fit (open polylines) or central difference across
/// the seam (closed loops), falling back to the chord when those degenerate.
fn estimate_start_tangent(points: &[Point<f64>], closed: bool) -> Option<Vector<f64>> {
    if points.len() < 2 {
        return None;
    }
    if points.len() < 3 {
        return normalize_or_none(points[1] - points[0]);
    }

    if closed {
        let prev = points[points.len() - 2];
        let next = points[1];
        if let Some(t) = normalize_or_none(next - prev) {
            return Some(t);
        }
    }

    if let Some((center, _r)) = fit_circle_through_three(points[0], points[1], points[2]) {
        let radial = points[0] - center;
        let tangent_ccw = Vector::new(-radial.y, radial.x);
        let to_next = points[1] - points[0];
        let tangent = if tangent_ccw.dot(to_next) >= 0.0 {
            tangent_ccw
        } else {
            -tangent_ccw
        };
        if let Some(t) = normalize_or_none(tangent) {
            return Some(t);
        }
    }

    normalize_or_none(points[1] - points[0])
}

/// Fit an arc that starts at `p0` tangent to `t0` (unit vector) and passes
/// through `p_end`. Such an arc is uniquely determined: its center lies on
/// the line through `p0` perpendicular to `t0`, and on the perpendicular
/// bisector of the chord. Returns `(center, radius, sweep_flag)` where
/// `sweep_flag` follows the SVG convention used elsewhere in this file
/// (positive cross product of start-radius × mid-radius => `true` => G3).
///
/// Returns `None` when the chord is colinear with the tangent (radius → ∞),
/// i.e. the polyline is going straight and should stay a line.
fn fit_arc_from_start_tangent(
    p0: Point<f64>,
    t0: Vector<f64>,
    p_end: Point<f64>,
) -> Option<(Point<f64>, f64, bool)> {
    // Left-hand normal (90° CCW rotation of t0). In the sign convention used
    // here, `s > 0` places the center on this side of the tangent line, which
    // corresponds to CCW motion from p0 toward the far side of the circle.
    let n0 = Vector::new(-t0.y, t0.x);
    let chord = p_end - p0;
    let chord_len_sq = chord.square_length();
    if chord_len_sq < 1.0e-20 {
        return None;
    }
    let denom = 2.0 * chord.dot(n0);
    if denom.abs() < 1.0e-10 {
        // Chord parallel to tangent => straight line.
        return None;
    }
    let s = chord_len_sq / denom;
    let radius = s.abs();
    if !radius.is_finite() || radius <= 0.0 {
        return None;
    }
    let center = p0 + n0 * s;
    Some((center, radius, s > 0.0))
}

/// Unsigned sweep in `[0, 2π)` from `v_start` to `v_point` around a shared
/// center, measured in the direction implied by `ccw` (sweep_flag). Used to
/// verify that interior points are angularly between start and end on the arc.
fn signed_sweep_from(v_start: Vector<f64>, v_point: Vector<f64>, ccw: bool) -> f64 {
    let cross = v_start.x * v_point.y - v_start.y * v_point.x;
    let dot = v_start.x * v_point.x + v_start.y * v_point.y;
    let ccw_angle = cross.atan2(dot); // signed, in (-π, π]
    let mut delta = if ccw { ccw_angle } else { -ccw_angle };
    if delta < 0.0 {
        delta += 2.0 * std::f64::consts::PI;
    }
    delta
}

/// Greedy polyline → arc fitter with C1 continuity.
///
/// Walks `points` forwards. Each fitted arc is constrained to start with the
/// tangent inherited from the previous segment (arc or line), so consecutive
/// segments share endpoints AND tangents — no kinks. Falls back to straight
/// lines when the next polyline step can't be satisfied by an arc under the
/// current tangent and tolerance. A line fallback resets the running tangent
/// to the line's direction, so the next step can pick up a fresh arc.
///
/// Assumes `points` is contiguous (no duplicate consecutive entries).
fn polyline_to_arcs(points: &[Point<f64>], tolerance: f64) -> Vec<ArcOrLineSegment<f64>> {
    if points.len() < 2 {
        return vec![];
    }
    if points.len() < 3 {
        return polyline_to_line_segments(points);
    }

    // Cap per-arc sweep so a single fit can't wrap most of a circle.
    const MAX_SWEEP: f64 = std::f64::consts::PI;

    let n = points.len();
    let closed = points[0] == points[n - 1];

    let Some(mut t_in) = estimate_start_tangent(points, closed) else {
        return polyline_to_line_segments(points);
    };

    // Any interior polyline vertex that turns by more than this angle
    // is treated as a corner, and an arc spanning it is rejected. Smooth
    // curves flattened at reasonable tolerance have per-vertex turns well
    // under 10°; 25° is comfortably above that while still catching miter
    // corners on letter glyph offset polygons.
    const MAX_VERTEX_TURN: f64 = 25.0f64 * std::f64::consts::PI / 180.0;

    let mut result: Vec<ArcOrLineSegment<f64>> = Vec::new();
    let mut i = 0usize;

    while i + 1 < n {
        if points[i + 1] == points[i] {
            i += 1;
            continue;
        }

        let mut best: Option<(usize, Point<f64>, f64, bool)> = None;

        // Require at least one interior point: an arc through just two
        // vertices is underdetermined against the start tangent and lets
        // a bad seed tangent cascade through subsequent fits.
        let mut k = i + 3;
        while k < n {
            let Some((center, radius, sweep_flag)) =
                fit_arc_from_start_tangent(points[i], t_in, points[k])
            else {
                break;
            };

            // Cap sweep angle before validating interior points.
            let v_start = points[i] - center;
            let v_end = points[k] - center;
            let cos_sweep = (v_start.dot(v_end) / (radius * radius)).clamp(-1.0, 1.0);
            let sweep_angle = cos_sweep.acos();
            if sweep_angle > MAX_SWEEP {
                break;
            }

            // Sagitta = max perpendicular distance from chord to arc.
            // Below, we use it to reject arcs that are visually straight
            // lines (huge R, tiny deviation): R-form gcode with giant R
            // values breaks NC viewers. Compute here; apply after the
            // other validity checks so we can keep extending k when the
            // current arc is simply too short to have enough sweep yet.
            let sagitta = radius * (1.0 - (sweep_angle * 0.5).cos());

            // Every interior point must lie on the circle AND be angularly
            // between start and end in the sweep direction.
            let mut ok = true;
            for j in (i + 1)..k {
                let v_j = points[j] - center;
                let d = v_j.length();
                if (d - radius).abs() > tolerance {
                    ok = false;
                    break;
                }
                let a_j = signed_sweep_from(v_start, v_j, sweep_flag);
                if a_j < -1.0e-6 || a_j > sweep_angle + 1.0e-6 {
                    ok = false;
                    break;
                }
            }
            if !ok {
                break;
            }

            // Corner detection: if any interior vertex makes a sharp turn in
            // the underlying polyline, it's a genuine corner (e.g. a K's
            // miter junction). An arc that sweeps through it would curve
            // across empty space away from the real outline, even if the
            // corner's vertices coincidentally share a circle.
            let mut corner = false;
            for j in (i + 1)..k {
                let e_prev = points[j] - points[j - 1];
                let e_next = points[j + 1] - points[j];
                let lp = e_prev.length();
                let ln = e_next.length();
                if lp < 1.0e-9 || ln < 1.0e-9 {
                    continue;
                }
                let cos = (e_prev.dot(e_next) / (lp * ln)).clamp(-1.0, 1.0);
                if cos.acos() > MAX_VERTEX_TURN {
                    corner = true;
                    break;
                }
            }
            if corner {
                break;
            }

            // Confirm the arc goes the right way around the circle.
            let mid_idx = i + (k - i) / 2;
            let v_mid = points[mid_idx] - center;
            let cross = v_start.x * v_mid.y - v_start.y * v_mid.x;
            if (cross > 0.0) != sweep_flag {
                break;
            }

            // Only record as `best` when the arc is deep enough to be
            // distinguishable from a straight line within tolerance.
            // Shorter/shallower arcs just continue extending in the hope
            // that a larger k produces enough sweep.
            if sagitta >= tolerance * 2.0 {
                best = Some((k, center, radius, sweep_flag));
            }
            k += 1;
        }

        if let Some((end, center, radius, sweep_flag)) = best {
            result.push(ArcOrLineSegment::Arc(SvgArc {
                from: points[i],
                to: points[end],
                radii: Vector::new(radius, radius),
                x_rotation: lyon_geom::Angle::zero(),
                flags: lyon_geom::ArcFlags {
                    large_arc: false,
                    sweep: sweep_flag,
                },
            }));
            // Exit tangent = perpendicular to the end radius, in the sweep
            // direction. CCW: 90° CCW of (end - center); CW: 90° CW.
            let v_end = points[end] - center;
            let next_t = if sweep_flag {
                Vector::new(-v_end.y, v_end.x)
            } else {
                Vector::new(v_end.y, -v_end.x)
            };
            match normalize_or_none(next_t) {
                Some(t) => t_in = t,
                None => {
                    // Shouldn't happen for a valid arc; fall back to line
                    // direction from the next polyline step.
                    if end + 1 < n {
                        if let Some(t) = normalize_or_none(points[end + 1] - points[end]) {
                            t_in = t;
                        }
                    }
                }
            }
            i = end;
        } else {
            result.push(ArcOrLineSegment::Line(LineSegment {
                from: points[i],
                to: points[i + 1],
            }));
            if let Some(t) = normalize_or_none(points[i + 1] - points[i]) {
                t_in = t;
            }
            i += 1;
        }
    }

    result
}

fn build_toolpath_segments(
    points: &[Point<f64>],
    tolerance: f64,
    refit_arcs: bool,
) -> Vec<ArcOrLineSegment<f64>> {
    if refit_arcs {
        polyline_to_arcs(points, tolerance)
    } else {
        polyline_to_line_segments(points)
    }
}

fn contour_toolpath(
    contour: &Contour,
    depth: f64,
    target_depth: f64,
    tolerance: f64,
    refit_arcs: bool,
) -> Option<Toolpath> {
    let mut points = contour_to_points(contour);
    if points.len() < 3 {
        return None;
    }
    points.push(points[0]);
    let segments = build_toolpath_segments(&points, tolerance, refit_arcs);
    if segments.is_empty() {
        return None;
    }
    Some(Toolpath {
        segments,
        depth,
        target_depth,
    })
}

fn depth_passes(target_depth: f64, max_stepdown: f64) -> Vec<f64> {
    let mut depths = vec![];
    let mut current = 0.0;
    while current < target_depth {
        current = (current + max_stepdown).min(target_depth);
        depths.push(-current);
    }
    depths
}

fn count_contours(shapes: &[Shape]) -> usize {
    shapes.iter().map(Vec::len).sum()
}

fn fill_shape_loses_detail(shape: &Shape, tool_radius: f64) -> bool {
    let inset = inset_shapes(std::slice::from_ref(shape), tool_radius);
    if inset.is_empty() {
        return false;
    }

    inset.len() != 1 || count_contours(&inset) != shape.len()
}

fn translate_toolpaths(groups: &mut [OperationGroup], offset: Point<f64>) {
    let offset = Vector::new(offset.x, offset.y);
    for group in groups {
        for path in &mut group.paths {
            path.translate(offset);
        }
    }
}

fn build_stroke_groups(
    paths: Vec<StrokeSubpath>,
    depths: &[f64],
    target_depth: f64,
) -> Vec<OperationGroup> {
    paths
        .into_iter()
        .filter(|path| !path.segments.is_empty())
        .map(|path| OperationGroup {
            paths: depths
                .iter()
                .copied()
                .map(|depth| Toolpath {
                    segments: path.segments.clone(),
                    depth,
                    target_depth,
                })
                .collect(),
            reversible: true,
        })
        .collect()
}

struct FillGroupsResult {
    normal_groups: Vec<OperationGroup>,
    thickened_groups: Vec<OperationGroup>,
}

fn build_fill_groups(
    fill_shapes: &[Shape],
    depths: &[f64],
    tool_radius: f64,
    stepover: f64,
    max_fill_passes: Option<u32>,
    target_depth: f64,
    allow_thicken_routing: bool,
    tolerance: f64,
    refit_arcs: bool,
    warnings: &mut Vec<GenerationWarning>,
) -> FillGroupsResult {
    let mut normal_groups = vec![];
    let mut thickened_groups = vec![];

    for shape in fill_shapes {
        let mut paths = vec![];
        let mut had_any_paths = false;
        let mut too_thin = false;

        for depth in depths.iter().copied() {
            let mut current = inset_shapes(std::slice::from_ref(shape), tool_radius);
            if current.is_empty() {
                if !had_any_paths {
                    too_thin = true;
                }
                break;
            }

            had_any_paths = true;

            // When max_fill_passes is set, decide per-shape whether to
            // clamp or pocket fully.  Count inset *iterations* (not
            // contour paths — a ring always produces 2 contours per
            // iteration).  If the shape is "thin" (few iterations) we
            // collapse it to at most max_fill_passes contour paths.
            // If it needs many iterations it is a genuine pocket and
            // we fill it completely.
            let clamp_paths = if let Some(max) = max_fill_passes {
                let mut probe = current.clone();
                let mut iterations: u32 = 0;
                while !probe.is_empty() {
                    iterations += 1;
                    probe = inset_shapes(&probe, stepover);
                }
                if iterations <= max {
                    // Already fits — emit everything
                    None
                } else if iterations <= max * 3 {
                    // Thin feature — collapse to max paths
                    Some(max)
                } else {
                    // Genuine pocket — fill completely
                    None
                }
            } else {
                None
            };

            let mut path_count: u32 = 0;
            'fill: while !current.is_empty() {
                for inset_shape in &current {
                    for contour in inset_shape {
                        if let Some(limit) = clamp_paths {
                            if path_count >= limit {
                                break 'fill;
                            }
                        }
                        if let Some(path) = contour_toolpath(
                            contour,
                            depth,
                            target_depth,
                            tolerance,
                            refit_arcs,
                        ) {
                            paths.push(path);
                            path_count += 1;
                        }
                    }
                }
                current = inset_shapes(&current, stepover);
            }
        }

        if !paths.is_empty() {
            normal_groups.push(OperationGroup {
                paths,
                reversible: false,
            });
        } else if too_thin {
            if allow_thicken_routing {
                // Route the thin shape in contour mode: bit traces the perimeter.
                // The bit is wider than the feature so the cut thickens it.
                let contour_groups = build_fill_contour_groups(
                    std::slice::from_ref(shape),
                    depths,
                    target_depth,
                    tolerance,
                    refit_arcs,
                );
                thickened_groups.extend(contour_groups);
            } else {
                warnings.push(GenerationWarning::ToolTooLargeForFill);
            }
        }
    }

    FillGroupsResult {
        normal_groups,
        thickened_groups,
    }
}

fn build_fill_contour_groups(
    fill_shapes: &[Shape],
    depths: &[f64],
    target_depth: f64,
    tolerance: f64,
    refit_arcs: bool,
) -> Vec<OperationGroup> {
    let mut groups = vec![];

    for shape in fill_shapes {
        let mut paths = vec![];
        for depth in depths.iter().copied() {
            for contour in shape {
                if let Some(path) =
                    contour_toolpath(contour, depth, target_depth, tolerance, refit_arcs)
                {
                    paths.push(path);
                }
            }
        }

        if !paths.is_empty() {
            groups.push(OperationGroup {
                paths,
                reversible: false,
            });
        }
    }

    groups
}

fn distance(a: Point<f64>, b: Point<f64>) -> f64 {
    (a - b).length()
}

fn optimize_operation_groups(mut groups: Vec<OperationGroup>) -> Vec<OperationGroup> {
    if groups.len() <= 1 {
        return groups;
    }

    let mut ordered = Vec::with_capacity(groups.len());
    let mut current = Point::new(0.0, 0.0);

    while !groups.is_empty() {
        let mut best_index = 0usize;
        let mut best_reversed = false;
        let mut best_distance = f64::INFINITY;

        for (index, group) in groups.iter().enumerate() {
            let start = group.paths[0].start();
            let start_distance = distance(current, start);
            if start_distance < best_distance {
                best_distance = start_distance;
                best_index = index;
                best_reversed = false;
            }

            if group.reversible {
                let end = group.paths[0].end();
                let end_distance = distance(current, end);
                if end_distance < best_distance {
                    best_distance = end_distance;
                    best_index = index;
                    best_reversed = true;
                }
            }
        }

        let mut group = groups.swap_remove(best_index);
        if best_reversed {
            for path in &mut group.paths {
                path.reverse();
            }
        }
        current = group.paths.last().unwrap().end();
        ordered.push(group);
    }

    ordered
}

fn optimize_scheduled_operation_groups_from(
    mut groups: Vec<ScheduledOperationGroup>,
    mut current: Point<f64>,
) -> (Vec<ScheduledOperationGroup>, Point<f64>) {
    if groups.len() <= 1 {
        if let Some(last_group) = groups.last() {
            current = last_group.group.paths.last().unwrap().end();
        }
        return (groups, current);
    }

    let mut ordered = Vec::with_capacity(groups.len());

    while !groups.is_empty() {
        let mut best_index = 0usize;
        let mut best_reversed = false;
        let mut best_distance = f64::INFINITY;

        for (index, scheduled) in groups.iter().enumerate() {
            let start = scheduled.group.paths[0].start();
            let start_distance = distance(current, start);
            if start_distance < best_distance {
                best_distance = start_distance;
                best_index = index;
                best_reversed = false;
            }

            if scheduled.group.reversible {
                let end = scheduled.group.paths[0].end();
                let end_distance = distance(current, end);
                if end_distance < best_distance {
                    best_distance = end_distance;
                    best_index = index;
                    best_reversed = true;
                }
            }
        }

        let mut scheduled = groups.swap_remove(best_index);
        if best_reversed {
            for path in &mut scheduled.group.paths {
                path.reverse();
            }
        }
        current = scheduled.group.paths.last().unwrap().end();
        ordered.push(scheduled);
    }

    (ordered, current)
}

fn schedule_operation_groups_by_depth(
    operation_id: &str,
    operation_name: &str,
    groups: Vec<OperationGroup>,
) -> BTreeMap<u64, Vec<ScheduledOperationGroup>> {
    let mut scheduled = BTreeMap::<u64, Vec<ScheduledOperationGroup>>::new();

    for group in groups {
        let reversible = group.reversible;
        let mut depth_paths = BTreeMap::<u64, Vec<Toolpath>>::new();

        for path in group.paths {
            depth_paths
                .entry(path.depth.to_bits())
                .or_default()
                .push(path);
        }

        for (depth_key, paths) in depth_paths {
            scheduled
                .entry(depth_key)
                .or_default()
                .push(ScheduledOperationGroup {
                    operation_id: operation_id.to_string(),
                    operation_name: operation_name.to_string(),
                    group: OperationGroup { paths, reversible },
                });
        }
    }

    scheduled
}

fn collect_warnings(
    warnings: impl IntoIterator<Item = GenerationWarning>,
) -> Vec<GenerationWarning> {
    let mut deduped = BTreeMap::<GenerationWarning, ()>::new();
    for warning in warnings {
        deduped.insert(warning, ());
    }
    deduped.into_keys().collect()
}

fn toolpath_bounds(groups: &[OperationGroup]) -> Option<(f64, f64, f64, f64)> {
    let mut iter = groups
        .iter()
        .flat_map(|group| group.paths.iter())
        .flat_map(|path| path.bounds_sample_points());
    let first = iter.next()?;
    let mut min_x = first.x;
    let mut min_y = first.y;
    let mut max_x = first.x;
    let mut max_y = first.y;

    for point in iter {
        min_x = min_x.min(point.x);
        min_y = min_y.min(point.y);
        max_x = max_x.max(point.x);
        max_y = max_y.max(point.y);
    }

    Some((min_x, min_y, max_x, max_y))
}

fn comment_token<'input>(text: impl Into<String>) -> Token<'input> {
    Token::Comment {
        is_inline: false,
        inner: Cow::Owned(text.into()),
    }
}

fn append_rapid_z<'input>(program: &mut Vec<Token<'input>>, z: f64) {
    program.append(&mut command!(RapidPositioning { Z: z }).into_token_vec());
}

fn append_rapid_xy<'input>(program: &mut Vec<Token<'input>>, point: Point<f64>) {
    program.append(
        &mut command!(RapidPositioning {
            X: point.x,
            Y: point.y,
        })
        .into_token_vec(),
    );
}

fn append_plunge<'input>(program: &mut Vec<Token<'input>>, depth: f64, plunge_feedrate: f64) {
    program.append(
        &mut command!(LinearInterpolation {
            Z: depth,
            F: plunge_feedrate,
        })
        .into_token_vec(),
    );
}

fn append_cut_move<'input>(program: &mut Vec<Token<'input>>, point: Point<f64>, cut_feedrate: f64) {
    program.append(
        &mut command!(LinearInterpolation {
            X: point.x,
            Y: point.y,
            F: cut_feedrate,
        })
        .into_token_vec(),
    );
}

/// Emit a `G2`/`G3` circular interpolation for `svg_arc`. `large_arc` arcs
/// are split in half and recursed. Mirrors the logic in
/// [`crate::turtle::g_code::GCodeTurtle::circular_interpolation`].
fn append_circular_cut_move<'input>(
    program: &mut Vec<Token<'input>>,
    svg_arc: SvgArc<f64>,
    cut_feedrate: f64,
) {
    match (svg_arc.flags.large_arc, svg_arc.flags.sweep) {
        (false, true) => program.append(
            &mut command!(CounterclockwiseCircularInterpolation {
                X: svg_arc.to.x,
                Y: svg_arc.to.y,
                R: svg_arc.radii.x,
                F: cut_feedrate,
            })
            .into_token_vec(),
        ),
        (false, false) => program.append(
            &mut command!(ClockwiseCircularInterpolation {
                X: svg_arc.to.x,
                Y: svg_arc.to.y,
                R: svg_arc.radii.x,
                F: cut_feedrate,
            })
            .into_token_vec(),
        ),
        (true, _) => {
            let (left, right) = svg_arc.to_arc().split(0.5);
            append_circular_cut_move(program, left.to_svg_arc(), cut_feedrate);
            append_circular_cut_move(program, right.to_svg_arc(), cut_feedrate);
        }
    }
}

fn append_segment_cut_move<'input>(
    program: &mut Vec<Token<'input>>,
    segment: &ArcOrLineSegment<f64>,
    cut_feedrate: f64,
    tolerance: f64,
    circular_interpolation: bool,
) {
    match segment {
        ArcOrLineSegment::Line(line) => append_cut_move(program, line.to, cut_feedrate),
        ArcOrLineSegment::Arc(arc) => {
            if arc.is_straight_line() {
                append_cut_move(program, arc.to, cut_feedrate);
                return;
            }
            if circular_interpolation {
                append_circular_cut_move(program, *arc, cut_feedrate);
            } else {
                // Machine can't do G2/G3 — flatten the arc back to G1
                // segments on the fly at the shared CAM tolerance.
                for point in arc.to_arc().flattened(tolerance) {
                    append_cut_move(program, point, cut_feedrate);
                }
            }
        }
    }
}

fn cut_feedrate_for_depth(engraving: &EngravingConfig, depth: f64, target_depth: f64) -> f64 {
    let Some(shallow_feedrate) = engraving.shallow_cut_feedrate else {
        return engraving.cut_feedrate;
    };
    if target_depth <= 0.0 {
        return engraving.cut_feedrate;
    }

    let depth_ratio = (depth.abs() / target_depth).clamp(0.0, 1.0);
    shallow_feedrate + (engraving.cut_feedrate - shallow_feedrate) * depth_ratio
}

fn validate_engraving_config(engraving: &EngravingConfig) -> Result<(), String> {
    if engraving.target_depth <= 0.0 {
        return Err("Target depth must be greater than 0.".into());
    }
    if engraving.max_stepdown <= 0.0 {
        return Err("Max stepdown must be greater than 0.".into());
    }
    if engraving.cut_feedrate <= 0.0 {
        return Err("Cut feedrate must be greater than 0.".into());
    }
    if let Some(shallow_cut_feedrate) = engraving.shallow_cut_feedrate {
        if shallow_cut_feedrate <= 0.0 {
            return Err("Shallow cut feedrate must be greater than 0.".into());
        }
    }
    if engraving.plunge_feedrate <= 0.0 {
        return Err("Plunge feedrate must be greater than 0.".into());
    }
    if engraving.tool_diameter <= 0.0 {
        return Err("Tool diameter must be greater than 0.".into());
    }
    if engraving.stepover <= 0.0 {
        return Err("Stepover must be greater than 0.".into());
    }

    Ok(())
}

fn empty_engraving_geometry_error(
    has_fill_shapes: bool,
    has_stroke_paths: bool,
    warnings: &[GenerationWarning],
) -> String {
    if has_fill_shapes
        && !has_stroke_paths
        && warnings.contains(&GenerationWarning::ToolTooLargeForFill)
    {
        return "Filled SVG geometry was found, but the selected tool diameter is too large to fit inside any filled region. Reduce the tool diameter or use stroke engraving.".into();
    }

    "No engravable SVG geometry was found. Add fills and/or strokes.".into()
}

fn apply_dimension_overrides(
    mut options: ConversionOptions,
    engraving: &EngravingConfig,
) -> ConversionOptions {
    if let Some(width) = engraving.svg_width_override {
        options.dimensions[0] = Some(Length {
            number: width,
            unit: LengthUnit::Mm,
        });
        options.dimensions[1] = None;
    }

    options
}

fn collect_engraving_groups<'a>(
    doc: &'a Document,
    config: &ConversionConfig,
    engraving: &EngravingConfig,
    options: ConversionOptions,
    allow_thicken_routing: bool,
    circular_interpolation: bool,
) -> Result<
    (
        Vec<OperationGroup>,
        Vec<OperationGroup>,
        Vec<GenerationWarning>,
    ),
    String,
> {
    validate_engraving_config(engraving)?;
    let options = apply_dimension_overrides(options, engraving);
    let selector_filter = config
        .selector_filter
        .as_deref()
        .map(|s| SelectorList::parse(s).expect("invalid selector_filter"));
    let stylesheet = super::css::Stylesheet::from_document(doc);

    let bounding_box_generator = || {
        let mut visitor = ConversionVisitor {
            terrarium: crate::turtle::Terrarium::new(crate::turtle::DpiConvertingTurtle {
                inner: crate::turtle::PreprocessTurtle::default(),
                dpi: config.dpi,
            }),
            _config: config,
            options: options.clone(),
            name_stack: vec![],
            paint_stack: vec![PaintStyle::default()],
            viewport_dim_stack: vec![],
            selector_filter: selector_filter.clone(),
            stylesheet: stylesheet.clone(),
        };

        visitor.begin();
        visit::depth_first_visit(doc, &mut visitor);
        visitor.end();
        visitor.terrarium.turtle.inner.bounding_box
    };

    let origin = config
        .origin
        .map(|dim| dim.map(|d| UomLength::new::<millimeter>(d).get::<inch>() * CSS_DEFAULT_DPI));
    let origin_transform = match origin {
        [None, Some(origin_y)] => {
            let bb = bounding_box_generator();
            Transform2D::translation(0., origin_y - bb.min.y)
        }
        [Some(origin_x), None] => {
            let bb = bounding_box_generator();
            Transform2D::translation(origin_x - bb.min.x, 0.)
        }
        [Some(origin_x), Some(origin_y)] => {
            let bb = bounding_box_generator();
            Transform2D::translation(origin_x - bb.min.x, origin_y - bb.min.y)
        }
        [None, None] => Transform2D::identity(),
    };

    let mut collect_visitor = ConversionVisitor {
        terrarium: crate::turtle::Terrarium::new(crate::turtle::DpiConvertingTurtle {
            inner: CamTurtle::new(config.tolerance, circular_interpolation),
            dpi: config.dpi,
        }),
        _config: config,
        options,
        name_stack: vec![],
        paint_stack: vec![PaintStyle::default()],
        viewport_dim_stack: vec![],
        selector_filter,
        stylesheet,
    };
    collect_visitor.terrarium.push_transform(origin_transform);
    collect_visitor.begin();
    visit::depth_first_visit(doc, &mut collect_visitor);
    collect_visitor.end();
    collect_visitor.terrarium.pop_transform();

    let cam_turtle = collect_visitor.terrarium.turtle.inner;
    let has_stroke_paths = !cam_turtle.stroke_paths.is_empty();
    let fill_shapes = simplify_fill_nodes(cam_turtle.fill_nodes);
    let has_fill_shapes = !fill_shapes.is_empty();
    let depths = depth_passes(engraving.target_depth, engraving.max_stepdown);
    let tool_radius = engraving.tool_diameter * 0.5;

    let mut warnings = Vec::new();
    if engraving.target_depth > engraving.material_thickness {
        warnings.push(GenerationWarning::DepthExceedsMaterialThickness);
    }

    let mut groups = build_stroke_groups(cam_turtle.stroke_paths, &depths, engraving.target_depth);
    let mut thickened_groups: Vec<OperationGroup> = vec![];

    match engraving.fill_mode {
        FillMode::Pocket => {
            if fill_shapes
                .iter()
                .any(|shape| fill_shape_loses_detail(shape, tool_radius))
            {
                warnings.push(GenerationWarning::FillDetailLoss);
            }

            let fill_result = build_fill_groups(
                &fill_shapes,
                &depths,
                tool_radius,
                engraving.stepover,
                engraving.max_fill_passes,
                engraving.target_depth,
                allow_thicken_routing,
                config.tolerance,
                circular_interpolation,
                &mut warnings,
            );
            groups.extend(fill_result.normal_groups);
            if !fill_result.thickened_groups.is_empty() {
                warnings.push(GenerationWarning::ThickenedFeatureRouting);
                thickened_groups.extend(fill_result.thickened_groups);
            }
        }
        FillMode::Contour => {
            groups.extend(build_fill_contour_groups(
                &fill_shapes,
                &depths,
                engraving.target_depth,
                config.tolerance,
                circular_interpolation,
            ));
        }
    }

    if groups.is_empty() && thickened_groups.is_empty() {
        return Err(empty_engraving_geometry_error(
            has_fill_shapes,
            has_stroke_paths,
            &warnings,
        ));
    }

    translate_toolpaths(
        &mut groups,
        Point::new(engraving.placement_x, engraving.placement_y),
    );
    groups = optimize_operation_groups(groups);

    if let Some((min_x, min_y, max_x, max_y)) = toolpath_bounds(&groups) {
        if min_x < tool_radius
            || min_y < tool_radius
            || max_x > engraving.material_width - tool_radius
            || max_y > engraving.material_height - tool_radius
        {
            warnings.push(GenerationWarning::MaterialBoundsExceeded);
        }
    }

    Ok((
        optimize_operation_groups(groups),
        thickened_groups,
        collect_warnings(warnings),
    ))
}

fn append_engraving_program_header<'input>(
    program: &mut Vec<Token<'input>>,
    machine: &mut Machine<'input>,
) {
    program.append(&mut command!(UnitsMillimeters {}).into_token_vec());
    program.extend(machine.absolute());
    program.extend(machine.program_begin());
    program.extend(machine.absolute());
    program.push(comment_token("Engraving CAM"));
}

fn append_engraving_paths<'input>(
    program: &mut Vec<Token<'input>>,
    machine: &mut Machine<'input>,
    engraving: &EngravingConfig,
    groups: Vec<OperationGroup>,
    tolerance: f64,
) {
    let travel_z = machine
        .z_motion()
        .map(|(travel_z, _, _)| travel_z)
        .unwrap_or(2.0);
    let circular_interpolation = machine.supported_functionality().circular_interpolation;

    for group in groups {
        for path in group.paths {
            if path.segments.is_empty() {
                continue;
            }
            program.extend(machine.tool_off());
            program.extend(machine.absolute());
            program.extend(machine.path_begin());
            program.extend(machine.absolute());
            append_rapid_z(program, travel_z);
            append_rapid_xy(program, path.start());
            program.extend(machine.tool_on());
            program.extend(machine.absolute());
            append_plunge(program, path.depth, engraving.plunge_feedrate);
            let cut_feedrate = cut_feedrate_for_depth(engraving, path.depth, path.target_depth);
            for segment in &path.segments {
                append_segment_cut_move(
                    program,
                    segment,
                    cut_feedrate,
                    tolerance,
                    circular_interpolation,
                );
            }
        }
    }
}

fn append_operation_start_marker<'input>(
    program: &mut Vec<Token<'input>>,
    operation_id: &str,
    operation_name: &str,
) {
    program.push(comment_token(format!(
        "operation:start:{}:{}",
        operation_id, operation_name
    )));
}

fn append_operation_end_marker<'input>(program: &mut Vec<Token<'input>>, operation_id: &str) {
    program.push(comment_token(format!("operation:end:{operation_id}")));
}

fn append_engraving_program_footer<'input>(
    program: &mut Vec<Token<'input>>,
    machine: &mut Machine<'input>,
) {
    let travel_z = machine
        .z_motion()
        .map(|(travel_z, _, _)| travel_z)
        .unwrap_or(2.0);
    program.extend(machine.tool_off());
    program.extend(machine.absolute());
    append_rapid_z(program, travel_z);
    program.extend(machine.program_end());
}

pub fn svg2program_engraving<'a, 'input: 'a>(
    doc: &'a Document,
    config: &ConversionConfig,
    options: ConversionOptions,
    machine: Machine<'input>,
    engraving: &EngravingConfig,
) -> Result<(Vec<Token<'input>>, Vec<GenerationWarning>), String> {
    let circular_interpolation = machine.supported_functionality().circular_interpolation;
    let (groups, _thickened, warnings) =
        collect_engraving_groups(doc, config, engraving, options, false, circular_interpolation)?;
    if groups.is_empty() {
        return Err("No engravable SVG geometry was found. Add fills and/or strokes.".into());
    }

    let mut machine = machine;
    let mut program = vec![];
    append_engraving_program_header(&mut program, &mut machine);
    append_engraving_paths(&mut program, &mut machine, engraving, groups, config.tolerance);
    append_engraving_program_footer(&mut program, &mut machine);

    Ok((program, warnings))
}

pub fn svg2program_engraving_multi<'a, 'input: 'a>(
    doc: &'a Document,
    config: &ConversionConfig,
    options: ConversionOptions,
    machine: Machine<'input>,
    engraving: &EngravingConfig,
    operations: &[EngravingOperation],
) -> Result<(Vec<Token<'input>>, Vec<GenerationWarning>), String> {
    svg2program_engraving_multi_with_progress(
        doc, config, options, machine, engraving, operations, None,
    )
}

pub fn svg2program_engraving_multi_with_progress<'a, 'input: 'a>(
    doc: &'a Document,
    config: &ConversionConfig,
    options: ConversionOptions,
    machine: Machine<'input>,
    engraving: &EngravingConfig,
    operations: &[EngravingOperation],
    on_progress: Option<&dyn Fn(usize, usize, &str)>,
) -> Result<(Vec<Token<'input>>, Vec<GenerationWarning>), String> {
    validate_engraving_config(engraving)?;

    let mut machine = machine;
    let circular_interpolation = machine.supported_functionality().circular_interpolation;
    let mut program = vec![];
    let mut warnings = Vec::new();
    let mut emitted_any_geometry = false;
    let mut scheduled_groups = BTreeMap::<u64, Vec<ScheduledOperationGroup>>::new();
    let total_ops = operations.len();

    append_engraving_program_header(&mut program, &mut machine);

    for (op_index, operation) in operations.iter().enumerate() {
        if operation.selector_filter.trim().is_empty() {
            continue;
        }

        if let Some(cb) = &on_progress {
            cb(op_index, total_ops, "processing");
        }

        let mut operation_config = config.clone();
        operation_config.selector_filter = Some(operation.selector_filter.clone());

        let mut operation_engraving = engraving.clone();
        operation_engraving.target_depth = operation.target_depth;
        if let Some(fm) = operation.fill_mode {
            operation_engraving.fill_mode = fm;
        }

        let (groups, thickened_groups, operation_warnings) = collect_engraving_groups(
            doc,
            &operation_config,
            &operation_engraving,
            options.clone(),
            operation.allow_thicken_routing,
            circular_interpolation,
        )?;

        warnings.extend(operation_warnings);

        if !groups.is_empty() {
            emitted_any_geometry = true;
            for (depth_key, depth_groups) in
                schedule_operation_groups_by_depth(&operation.id, &operation.name, groups)
            {
                scheduled_groups
                    .entry(depth_key)
                    .or_default()
                    .extend(depth_groups);
            }
        }

        if !thickened_groups.is_empty() {
            emitted_any_geometry = true;
            let thickened_id = format!("{}-thickened", operation.id);
            let thickened_name = format!("{} (thickened)", operation.name);
            let optimized = optimize_operation_groups(thickened_groups);
            for (depth_key, depth_groups) in
                schedule_operation_groups_by_depth(&thickened_id, &thickened_name, optimized)
            {
                scheduled_groups
                    .entry(depth_key)
                    .or_default()
                    .extend(depth_groups);
            }
        }
    }

    if !emitted_any_geometry {
        return Err("No engravable SVG geometry was found. Add fills and/or strokes.".into());
    }

    if let Some(cb) = &on_progress {
        cb(0, 0, "optimizing");
    }

    let mut current = Point::new(0.0, 0.0);
    for (_depth_key, groups) in scheduled_groups {
        let (ordered_groups, next_current) =
            optimize_scheduled_operation_groups_from(groups, current);
        current = next_current;
        for scheduled in ordered_groups {
            append_operation_start_marker(
                &mut program,
                &scheduled.operation_id,
                &scheduled.operation_name,
            );
            append_engraving_paths(
                &mut program,
                &mut machine,
                engraving,
                vec![scheduled.group],
                config.tolerance,
            );
            append_operation_end_marker(&mut program, &scheduled.operation_id);
        }
    }

    append_engraving_program_footer(&mut program, &mut machine);

    if let Some(cb) = &on_progress {
        cb(0, 0, "formatting");
    }

    Ok((program, collect_warnings(warnings)))
}

#[cfg(test)]
mod polyline_arc_tests {
    use super::*;

    fn arc_at(seg: &ArcOrLineSegment<f64>) -> Option<&SvgArc<f64>> {
        match seg {
            ArcOrLineSegment::Arc(a) => Some(a),
            ArcOrLineSegment::Line(_) => None,
        }
    }

    fn sample_circle(cx: f64, cy: f64, r: f64, start_deg: f64, end_deg: f64, n: usize) -> Vec<Point<f64>> {
        let mut pts = Vec::with_capacity(n + 1);
        for k in 0..=n {
            let t = k as f64 / n as f64;
            let angle = (start_deg + (end_deg - start_deg) * t).to_radians();
            pts.push(Point::new(cx + r * angle.cos(), cy + r * angle.sin()));
        }
        pts
    }

    #[test]
    fn circle_arc_fits_with_tangent_continuity() {
        // 48 points along half a circle => fitter should emit arcs that
        // reconstruct the circle within tolerance, no lines.
        let pts = sample_circle(0.0, 0.0, 5.0, 0.0, 180.0, 48);
        let segs = polyline_to_arcs(&pts, 0.02);
        assert!(!segs.is_empty());
        for seg in &segs {
            let arc = arc_at(seg).expect("circle sample should fit arcs, not lines");
            let r = arc.radii.x;
            assert!((r - 5.0).abs() < 0.05, "radius {} should be ~5", r);
        }
        // Tangent continuity: consecutive segment endpoints coincide.
        for w in segs.windows(2) {
            let prev_end = segment_to(&w[0]);
            let next_start = segment_from(&w[1]);
            assert!((prev_end - next_start).length() < 1e-9);
        }
    }

    #[test]
    fn straight_polyline_stays_as_lines() {
        let pts: Vec<_> = (0..=10).map(|k| Point::new(k as f64, 0.0)).collect();
        let segs = polyline_to_arcs(&pts, 0.1);
        for seg in &segs {
            assert!(matches!(seg, ArcOrLineSegment::Line(_)));
        }
    }

    #[test]
    fn nearly_straight_polyline_with_tiny_bow_emits_lines_not_huge_arcs() {
        // Polyline with a tiny 0.001 mm bow over a 10 mm span — clearly
        // within flattening noise. The fitter must not emit a G2/G3 with
        // a multi-million-mm radius; those break downstream NC viewers.
        let mut pts = Vec::new();
        for k in 0..=40 {
            let t = k as f64 / 40.0;
            let x = t * 10.0;
            // Very gentle parabolic bow: max deviation ~0.001 mm.
            let y = 0.001 * (1.0 - (2.0 * t - 1.0).powi(2));
            pts.push(Point::new(x, y));
        }
        let segs = polyline_to_arcs(&pts, 0.02);
        for seg in &segs {
            if let ArcOrLineSegment::Arc(a) = seg {
                assert!(
                    a.radii.x < 10_000.0,
                    "absurd arc radius {} for near-straight polyline",
                    a.radii.x
                );
            }
        }
    }

    #[test]
    fn polyline_with_sharp_corner_does_not_fit_arc_across_it() {
        // Two straight runs meeting at a 60° miter corner — like a K's top
        // junction. The vertices along each leg are collinear, so no arc
        // should fit along either leg, and definitely no arc should span
        // across the corner curving through empty space.
        let mut pts = Vec::new();
        for k in 0..=10 {
            pts.push(Point::new(k as f64 * 0.5, 0.0));
        }
        // 60° corner: next leg heads in direction (cos60°, sin60°).
        let cx = 10.0 * 0.5;
        let cy = 0.0;
        for k in 1..=10 {
            let d = k as f64 * 0.5;
            pts.push(Point::new(
                cx + d * 60.0f64.to_radians().cos(),
                cy + d * 60.0f64.to_radians().sin(),
            ));
        }
        let segs = polyline_to_arcs(&pts, 0.02);
        for seg in &segs {
            assert!(
                matches!(seg, ArcOrLineSegment::Line(_)),
                "no arc should fit across or along collinear legs of a corner"
            );
        }
    }

    #[test]
    fn u_turn_on_same_circle_does_not_fit_single_arc() {
        // Quarter arc forward, then quarter arc back along the same circle:
        // all points lie on the circle, but they form a U-turn. The fitter
        // must NOT accept one big arc across the reversal — the angular
        // check should catch it and break at the turnaround.
        let forward = sample_circle(0.0, 0.0, 5.0, 0.0, 90.0, 12);
        let mut pts = forward.clone();
        // Walk back along the same circle.
        for k in 1..=12 {
            let t = k as f64 / 12.0;
            let angle = (90.0 - 90.0 * t).to_radians();
            pts.push(Point::new(5.0 * angle.cos(), 5.0 * angle.sin()));
        }
        let segs = polyline_to_arcs(&pts, 0.02);
        // Every arc must stay on one side of the U-turn. No single arc
        // should span more than the ~90° of valid forward sweep.
        for seg in &segs {
            if let ArcOrLineSegment::Arc(a) = seg {
                let chord = (a.to - a.from).length();
                assert!(
                    chord < 8.0,
                    "arc chord {} implies a >90° sweep across the U-turn",
                    chord
                );
            }
        }
    }

    #[test]
    fn sharp_corner_breaks_into_lines() {
        // L-shape: horizontal run then vertical run, no smooth transition.
        let mut pts: Vec<_> = (0..=5).map(|k| Point::new(k as f64, 0.0)).collect();
        pts.extend((1..=5).map(|k| Point::new(5.0, k as f64)));
        let segs = polyline_to_arcs(&pts, 0.05);
        // At least the corner and first leg must be straight; no huge arcs.
        for seg in &segs {
            if let ArcOrLineSegment::Arc(a) = seg {
                assert!(a.radii.x < 50.0, "unexpected large-radius arc across corner");
            }
        }
    }
}
