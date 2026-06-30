// TypeScript interfaces mirroring backend/app/models/ir.py

export type ObjectType =
  | 'latex_text'
  | 'shape'
  | 'coordinate_system'
  | 'graph'
  | 'geometry'
  | 'matrix'
  | 'group';

export type AnimationVerb =
  | 'write'
  | 'create'
  | 'draw_border_then_fill'
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

export interface CameraTrack {
  initial_pan: Point2D;
  initial_zoom: number;
}

export interface Transition {
  type: TransitionType;
  duration: number;
}

export interface Scene {
  id: string;
  name: string;
  background_color?: string | null;
  objects: SceneObject[];
  relationships: Relationship[];
  timeline: Timeline;
  camera_track: CameraTrack;
  transition_in?: Transition | null;
  transition_out?: Transition | null;
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
}

export type RenderFormat = 'mp4' | 'gif' | 'png' | 'still';

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
