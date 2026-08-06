// TypeScript interfaces mirroring backend/app/models/ir.py

export type ObjectType =
  | 'latex_text'
  | 'text'
  | 'shape'
  | 'coordinate_system'
  | 'graph'
  | 'geometry'
  | 'matrix'
  | 'group'
  | 'image';

export type AnimationVerb =
  | 'write'
  | 'create'
  | 'draw_border_then_fill'
  | 'type_on'
  | 'fade_in'
  | 'fade_out'
  | 'transform'
  | 'replacement_transform'
  | 'morph_equation'
  | 'move'
  | 'scale'
  | 'rotate'
  | 'indicate'
  | 'circumscribe'
  | 'flash'
  | 'camera_move';

export type EasingType =
  | 'smooth'
  | 'linear'
  | 'rush_from'
  | 'rush_into'
  | 'there_and_back'
  | 'double_smooth';

export type RelationshipType = 'next_to' | 'align_to' | 'move_to_point' | 'center_on';

export type GroupType = 'parallel' | 'sequential_lagged';

export type TransitionType = 'fade_to_black' | 'wipe_left' | 'wipe_right' | 'crossfade';

export type ResolutionPreset = '480p' | '720p' | '1080p' | '4k';

// How a project's scenes are consumed. 'animation' = one continuous video
// (scenes stitched on export); 'slideshow' = each scene is a slide that plays,
// freezes on its last frame, and advances on a click.
export type ProjectKind = 'animation' | 'slideshow';

export interface Point2D {
  x: number;
  y: number;
}

export interface StyleDef {
  stroke_color?: string | null;
  stroke_width?: number | null;
  stroke_opacity?: number | null;
  fill_color?: string | null;
  fill_opacity?: number | null;
  gradient?: Record<string, unknown> | null;
  dash_array?: number[] | null;
}

export interface SceneObject {
  id: string;
  type: ObjectType;
  name: string;
  position: Point2D;
  anchor: string;
  z_index: number;
  style_ref?: string | null;
  style: StyleDef;
  props: Record<string, unknown>;
  parent_id?: string | null;
  visible: boolean;
}

// Props of a `text` SceneObject — plain (non-math) prose. Rendered as Manim
// `Tex` in text mode (backend LaTeX-escapes the raw string) and previewed via
// KaTeX `\text{...}`. `bold`/`italic` wrap the content.
export interface TextProps {
  text: string;
  font_size: number;
  bold: boolean;
  italic: boolean;
  // Unset/'' = the LaTeX `Tex` path above. A system font name (from GET /api/fonts)
  // switches the codegen to Manim's Pango-backed `Text`, which takes any installed
  // font; bold/italic then map to Pango weight/slant instead of \textbf/\textit.
  font?: string | null;
}

// Props of an `image` SceneObject (stored in the free-form `props` dict).
// `asset` is a filename in the project's assets dir (like AudioClip.asset);
// width/height are Manim units (both stored, so non-uniform stretch works).
export interface ImageProps {
  asset: string;
  width: number;
  height: number;
  opacity: number;
}

export interface Relationship {
  id: string;
  type: RelationshipType;
  subject_id: string;
  anchor_id: string;
  direction: string;
  buff: number;
  target_point?: Point2D | null;
}

export interface Keyframe {
  id: string;
  object_id: string;
  start_time: number;
  verb: AnimationVerb;
  duration: number;
  easing: EasingType;
  group_id?: string | null;
  params: Record<string, unknown>;
}

export interface AnimationGroup {
  id: string;
  type: GroupType;
  label: string;
  lag_ratio: number;
}

export interface Timeline {
  keyframes: Keyframe[];
  groups: AnimationGroup[];
}

// One clip on a scene's audio track (voiceover). `asset` is a filename in the
// project's assets dir; offset/duration select a window of the source file, so
// a cut is just two clips sharing one asset.
export interface AudioClip {
  id: string;
  name: string;
  asset: string;
  start_time: number; // where the clip sits on the scene timeline (s)
  offset: number; // trim-in point within the source file (s)
  duration: number; // clip length on the timeline (s)
  source_duration: number; // full source file length (s), for trim clamping
  gain: number; // linear volume (1.0 = as recorded)
  fade_in: number; // s
  fade_out: number; // s
  muted: boolean;
}

export interface CameraTrack {
  initial_pan: Point2D;
  initial_zoom: number;
}

export interface Transition {
  type: TransitionType;
  duration: number;
}

// A pause point inside a slide (slideshow projects only): playback stops here
// and waits for a click. Player-side only — the scene still renders as one
// continuous mp4, so breaks never reach codegen. Mirrors `SceneBreak` in ir.py.
export interface SceneBreak {
  id: string;
  time: number; // seconds from the start of the scene
}

export interface Scene {
  id: string;
  name: string;
  background_color?: string | null;
  objects: SceneObject[];
  relationships: Relationship[];
  timeline: Timeline;
  audio: AudioClip[];
  camera_track: CameraTrack;
  transition_in?: Transition | null;
  transition_out?: Transition | null;
  // Slideshow projects only: play the next slide automatically instead of
  // waiting for a click. Ignored by animation projects.
  auto_advance?: boolean;
  // Slideshow projects only: mid-slide pause points (see SceneBreak).
  breaks?: SceneBreak[];
}

export interface ProjectSettings {
  default_resolution: ResolutionPreset;
  default_fps: number;
  background_color: string;
  transparent_background: boolean;
  output_dir?: string | null;
}

export interface Project {
  version: string;
  id: string;
  kind: ProjectKind;
  created_at: string;
  updated_at: string;
  metadata: Record<string, string>;
  settings: ProjectSettings;
  styles: Record<string, StyleDef>;
  scenes: Scene[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  updated_at: string;
  scene_count: number;
  kind: ProjectKind;
}

// 'slideshow' renders every scene to its own mp4 and packages them with an HTML
// player into a zip; the unzipped player also stays on the server for Present mode.
export type RenderFormat = 'mp4' | 'gif' | 'png' | 'still' | 'slideshow';

export interface SlideInfo {
  index: number;
  name: string;
  file: string;
  duration: number;
  auto_advance: boolean;
  // Mid-slide pause timestamps (seconds), sorted, already clamped to the video.
  breaks: number[];
  url: string; // API path serving this slide's mp4
}

export interface SlideManifest {
  title: string;
  slides: SlideInfo[];
}

export interface RenderRequest {
  project_id: string;
  scene_id?: string | null;
  quality: 'preview' | 'final';
  resolution?: ResolutionPreset | null;
  fps?: number | null;
  format?: RenderFormat;
  transparent?: boolean;
  transition?: boolean;
}

export interface RenderJob {
  job_id: string;
  project_id: string;
  scene_id?: string | null;
  quality: string;
  format?: RenderFormat;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  message: string;
  output_path?: string | null;
}

export interface DepStatus {
  ok: boolean;
  version: string;
  error: string;
}

export type DepsResult = Record<string, DepStatus>;
