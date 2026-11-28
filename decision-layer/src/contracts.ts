/**
 * The two seams of the loop, as schemas (JSON Schema copies are generated into ../contracts/).
 *
 *   Isaac Sim ──captures.jsonl──┐
 *   image pipeline ──vision.jsonl──┴──▶ decision layer ──plan.json──▶ Isaac Sim (robots)
 *
 * Only grid positions cross the seams, never metres: cells are the operator UI's grid
 * (24 sectors × 8 wall rows, row 0 at the surface, col 0 at 0°), and the simulator converts a
 * cell to its own pen size. See docs/contracts.md for the walkthrough.
 */
import { z } from 'zod';

export const GRID = { sectors: 24, wallRows: 8 } as const;
const cell = z.number().int().min(0).max(GRID.sectors * GRID.wallRows - 1).describe('Wall cell on the UI grid: row * 24 + col');
const unit = z.number().min(0).max(1);

/** One line of Isaac's captures.jsonl (fishfarm_demo.py). Extra fields are kept, not rejected. */
export const SimCapture = z
  .object({
    image: z.string().describe('Image path relative to the run folder, e.g. auv_1/img_0003.png'),
    run_id: z.string(),
    auv: z.number().int().min(0),
    sim_time: z.number().min(0).describe('Seconds since the run started'),
    theta_deg: z.number(),
    depth: z.number().describe('z in metres, negative below the surface'),
    position: z.tuple([z.number(), z.number(), z.number()]),
    cell,
    target_id: z.string().optional().describe('Set when the photo was taken for a plan target (see InspectionPlan)'),
    // Simulator ground truth. Used only to score models and by the stand-in grader, never for decisions.
    fouling_frac: unit.optional(),
    thinning_frac: unit.optional(),
    holes_in_view: z.array(z.object({ cell, radius: z.number() }).loose()).optional(),
  })
  .loose();
export type SimCapture = z.infer<typeof SimCapture>;

export const DetectionClass = z.enum(['hole', 'mesh_opening', 'fraying', 'thinning', 'distortion', 'rope_contact', 'biofouling', 'other']);
export type DetectionClass = z.infer<typeof DetectionClass>;

/** One image as the image pipeline sees it. Images with no detections must be sent too. */
export const VisionReport = z.object({
  image: z.string().describe('Same path as in captures.jsonl, so the two join'),
  model: z.string().describe('Which detector/version produced this, e.g. "yolo-net-v3"'),
  quality: z
    .object({
      visibility: unit.describe('0 = nothing visible, 1 = clear water'),
      sharpness: unit.describe('0 = blurred, 1 = sharp'),
    })
    .optional()
    .describe('How usable the image is; low values make the layer ask for a closer or slower look'),
  fouling_pct: unit.optional().describe('Share of the visible net covered by growth'),
  detections: z.array(
    z.object({
      class: DetectionClass,
      confidence: unit,
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('[x, y, w, h] in pixels'),
      offset: z
        .tuple([z.number().min(-1).max(1), z.number().min(-1).max(1)])
        .optional()
        .describe('Centre of the detection relative to the image centre, -1..1, x right, y down (the classifier\'s dx, dy). Lets the layer place it on the right cell and aim close-ups at it'),
      severity: z.union([z.enum(['low', 'medium', 'high']), unit]).optional(),
      size_m: z.number().min(0).optional().describe('Estimated size of the defect'),
      crop: z.string().optional(),
    }),
  ),
  heatmap: z.string().optional().describe('Path to a heatmap image for the UI and the trace'),
  where: z
    .object({ pen_id: z.number().int(), cell, auv: z.number().int().optional(), time: z.string().optional() })
    .optional()
    .describe('Only for images without a captures.jsonl record (e.g. real footage)'),
});
export type VisionReport = z.infer<typeof VisionReport>;

const reason = z.object({ rule: z.string(), text: z.string() });

/** What the decision layer asks the robots to do next, best first. */
export const InspectionPlan = z.object({
  plan_id: z.string(),
  created_at: z.string(),
  pen_id: z.number().int(),
  day: z.number().int(),
  rules_version: z.string(),
  grid: z.object({ sectors: z.literal(GRID.sectors), wall_rows: z.literal(GRID.wallRows) }),
  robots: z.number().int().min(1),
  targets: z.array(
    z.object({
      target_id: z.string().describe('Copy into the capture record of every photo taken for this target'),
      mission_id: z.number().int(),
      cell,
      row: z.number().int(),
      col: z.number().int(),
      theta_deg: z.number().describe('Where the camera should look: the defect\'s position when a detection placed it (rule A1), else the cell centre'),
      depth_frac: unit.describe('Same point, as a fraction of the net wall depth (0 = surface)'),
      priority: unit,
      priority_label: z.enum(['high', 'normal', 'low']),
      reasons: z.array(reason).min(1),
      scan: z.object({
        standoff_m: z.number().positive().describe('Distance from the net for the photos'),
        shots: z.number().int().min(1).describe('Photos per viewpoint'),
        viewpoints: z
          .array(z.object({ d_theta_deg: z.number(), d_depth_frac: z.number() }))
          .min(1)
          .describe('Offsets from the cell centre; several = look from different angles'),
      }),
      safety: z.object({ margin_m: z.number().positive().describe('HOCBF inflation to use while on this target') }),
      robots: z.array(z.number().int().min(0)).min(1).describe('Which AUVs do this target; two = two perspectives'),
    }),
  ),
  coverage: z.array(cell).describe('After the targets: cells to sweep as usual, stalest first'),
});
export type InspectionPlan = z.infer<typeof InspectionPlan>;
export type PlanTarget = InspectionPlan['targets'][number];
