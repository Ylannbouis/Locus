"""Canonical IR schema — every other module imports from here."""
from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional, Union
from pydantic import BaseModel, Field
import uuid


def new_id() -> str:
    return str(uuid.uuid4())[:8]


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class ObjectType(str, Enum):
    LATEX_TEXT = "latex_text"
    SHAPE = "shape"
    COORDINATE_SYSTEM = "coordinate_system"
    GRAPH = "graph"
    GEOMETRY = "geometry"
    MATRIX = "matrix"
    GROUP = "group"


class AnimationVerb(str, Enum):
    WRITE = "write"
    CREATE = "create"
    DRAW_BORDER_THEN_FILL = "draw_border_then_fill"
    FADE_IN = "fade_in"
    FADE_OUT = "fade_out"
    TRANSFORM = "transform"
    REPLACEMENT_TRANSFORM = "replacement_transform"
    MORPH_EQUATION = "morph_equation"
    MOVE = "move"
    SCALE = "scale"
    ROTATE = "rotate"
    INDICATE = "indicate"
    CIRCUMSCRIBE = "circumscribe"
    FLASH = "flash"
    CAMERA_MOVE = "camera_move"


class EasingType(str, Enum):
    SMOOTH = "smooth"
    LINEAR = "linear"
    RUSH_FROM = "rush_from"
    RUSH_INTO = "rush_into"
    THERE_AND_BACK = "there_and_back"
    DOUBLE_SMOOTH = "double_smooth"


class RelationshipType(str, Enum):
    NEXT_TO = "next_to"
    ALIGN_TO = "align_to"
    MOVE_TO_POINT = "move_to_point"
    CENTER_ON = "center_on"


class GroupType(str, Enum):
    PARALLEL = "parallel"
    SEQUENTIAL_LAGGED = "sequential_lagged"


class TransitionType(str, Enum):
    FADE_TO_BLACK = "fade_to_black"
    WIPE_LEFT = "wipe_left"
    WIPE_RIGHT = "wipe_right"
    CROSSFADE = "crossfade"


class ResolutionPreset(str, Enum):
    P480 = "480p"
    P720 = "720p"
    P1080 = "1080p"
    P4K = "4k"


# ---------------------------------------------------------------------------
# Shared building blocks
# ---------------------------------------------------------------------------

class Point2D(BaseModel):
    x: float = 0.0
    y: float = 0.0


class StyleDef(BaseModel):
    stroke_color: Optional[str] = None
    stroke_width: Optional[float] = None
    stroke_opacity: Optional[float] = None
    fill_color: Optional[str] = None
    fill_opacity: Optional[float] = None
    gradient: Optional[dict[str, Any]] = None
    dash_array: Optional[list[float]] = None


# ---------------------------------------------------------------------------
# Object props (per type)
# ---------------------------------------------------------------------------

class LatexTextProps(BaseModel):
    tex_string: str = ""
    font_size: int = 42
    color_map: dict[str, str] = Field(default_factory=dict)
    use_mathtex: bool = True


class ShapeProps(BaseModel):
    subtype: str  # rectangle | circle | ellipse | arrow | double_arrow | line | dashed_line | polygon
    # rectangle / ellipse
    width: Optional[float] = None
    height: Optional[float] = None
    # circle
    radius: Optional[float] = None
    # arrow / line / dashed_line
    start_point: Optional[Point2D] = None
    end_point: Optional[Point2D] = None
    tip_length: Optional[float] = None
    dash_length: Optional[float] = None
    dashed_ratio: Optional[float] = None
    # polygon
    vertices: Optional[list[Point2D]] = None


class AxisConfig(BaseModel):
    include_tip: bool = True
    include_numbers: bool = True
    tip_length: float = 0.2
    numbers_with_elongated_ticks: list[int] = Field(default_factory=list)


class CoordinateSystemProps(BaseModel):
    subtype: str  # axes | number_line | polar_plane | number_plane
    x_range: Optional[list[float]] = None
    y_range: Optional[list[float]] = None
    x_length: Optional[float] = None
    y_length: Optional[float] = None
    length: Optional[float] = None
    axis_config: Optional[AxisConfig] = None
    x_axis_config: Optional[dict[str, Any]] = None
    y_axis_config: Optional[dict[str, Any]] = None
    x_axis_label: Optional[str] = None
    y_axis_label: Optional[str] = None
    radius_max: Optional[float] = None
    azimuth_step: Optional[float] = None
    include_numbers: Optional[bool] = None
    number_font_size: Optional[float] = None


class GraphProps(BaseModel):
    subtype: str  # function_plot | parametric | implicit | vector_field | stream_lines
    axes_ref: Optional[str] = None  # object id of the coordinate_system
    expression: Optional[str] = None
    x_range: Optional[list[float]] = None
    y_range: Optional[list[float]] = None
    use_smoothing: bool = True
    # parametric
    x_expression: Optional[str] = None
    y_expression: Optional[str] = None
    t_range: Optional[list[float]] = None
    # vector field
    x_func: Optional[str] = None
    y_func: Optional[str] = None


class GeometryProps(BaseModel):
    subtype: str  # vector | angle | brace | labeled_polygon
    direction: Optional[Point2D] = None
    label: Optional[str] = None
    line1_id: Optional[str] = None
    line2_id: Optional[str] = None
    radius: Optional[float] = None
    target_id: Optional[str] = None
    direction_str: Optional[str] = None  # UP | DOWN | LEFT | RIGHT for brace
    vertices: Optional[list[Point2D]] = None


class MatrixProps(BaseModel):
    entries: list[list[str]] = Field(default_factory=lambda: [["a", "b"], ["c", "d"]])
    left_bracket: str = "["
    right_bracket: str = "]"
    element_color_map: dict[str, str] = Field(default_factory=dict)


ObjectProps = Union[LatexTextProps, ShapeProps, CoordinateSystemProps, GraphProps, GeometryProps, MatrixProps, dict]


# ---------------------------------------------------------------------------
# Scene object
# ---------------------------------------------------------------------------

class SceneObject(BaseModel):
    id: str = Field(default_factory=new_id)
    type: ObjectType
    name: str = ""
    position: Optional[Point2D] = Field(default_factory=Point2D)
    anchor: str = "center"
    z_index: int = 0
    style_ref: Optional[str] = None
    style: StyleDef = Field(default_factory=StyleDef)
    props: dict[str, Any] = Field(default_factory=dict)
    parent_id: Optional[str] = None
    visible: bool = True


# ---------------------------------------------------------------------------
# Relationships
# ---------------------------------------------------------------------------

class Relationship(BaseModel):
    id: str = Field(default_factory=new_id)
    type: RelationshipType
    subject_id: str
    anchor_id: str
    direction: str = "UP"  # UP | DOWN | LEFT | RIGHT
    buff: float = 0.5
    target_point: Optional[Point2D] = None


# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------

class Keyframe(BaseModel):
    id: str = Field(default_factory=new_id)
    object_id: str  # object id or "__camera__"
    start_time: float = 0.0
    verb: AnimationVerb
    duration: float = 1.0
    easing: EasingType = EasingType.SMOOTH
    group_id: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)


class AnimationGroup(BaseModel):
    id: str = Field(default_factory=new_id)
    type: GroupType = GroupType.PARALLEL
    label: str = ""
    lag_ratio: float = 0.0


class Timeline(BaseModel):
    keyframes: list[Keyframe] = Field(default_factory=list)
    groups: list[AnimationGroup] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

class AudioClip(BaseModel):
    """One clip on a scene's audio track (voiceover). `asset` is a filename in
    the project's assets dir; `offset`/`duration` select a window of the source
    file, so a cut is just two clips sharing one asset."""
    id: str = Field(default_factory=new_id)
    name: str = ""
    asset: str = ""
    start_time: float = 0.0        # where the clip sits on the scene timeline (s)
    offset: float = 0.0            # trim-in point within the source file (s)
    duration: float = 1.0          # clip length on the timeline (s)
    source_duration: float = 0.0   # full source file length (s), for trim clamping
    gain: float = 1.0              # linear volume (1.0 = as recorded)
    fade_in: float = 0.0           # s
    fade_out: float = 0.0          # s
    muted: bool = False


# ---------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------

class CameraTrack(BaseModel):
    initial_pan: Point2D = Field(default_factory=Point2D)
    initial_zoom: float = 1.0


# ---------------------------------------------------------------------------
# Transition
# ---------------------------------------------------------------------------

class Transition(BaseModel):
    type: TransitionType = TransitionType.FADE_TO_BLACK
    duration: float = 0.8


# ---------------------------------------------------------------------------
# Scene
# ---------------------------------------------------------------------------

class Scene(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str = "Untitled Scene"
    background_color: Optional[str] = None
    objects: list[SceneObject] = Field(default_factory=list)
    relationships: list[Relationship] = Field(default_factory=list)
    timeline: Timeline = Field(default_factory=Timeline)
    audio: list[AudioClip] = Field(default_factory=list)
    camera_track: CameraTrack = Field(default_factory=CameraTrack)
    transition_in: Optional[Transition] = None
    transition_out: Optional[Transition] = None


# ---------------------------------------------------------------------------
# Project settings
# ---------------------------------------------------------------------------

class ProjectSettings(BaseModel):
    default_resolution: ResolutionPreset = ResolutionPreset.P1080
    default_fps: int = 30
    background_color: str = "#000000"
    transparent_background: bool = False
    output_dir: Optional[str] = None


# ---------------------------------------------------------------------------
# Project (top level)
# ---------------------------------------------------------------------------

class Project(BaseModel):
    version: str = "1.0.0"
    id: str = Field(default_factory=new_id)
    created_at: str = ""
    updated_at: str = ""
    metadata: dict[str, str] = Field(default_factory=lambda: {"name": "Untitled Project", "author": "", "description": ""})
    settings: ProjectSettings = Field(default_factory=ProjectSettings)
    styles: dict[str, StyleDef] = Field(default_factory=lambda: {
        "default": StyleDef(stroke_color="#FFFFFF", stroke_width=2.0, stroke_opacity=1.0, fill_opacity=0.0)
    })
    scenes: list[Scene] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# API request/response helpers
# ---------------------------------------------------------------------------

class ProjectSummary(BaseModel):
    id: str
    name: str
    updated_at: str
    scene_count: int


RenderFormat = Literal["mp4", "gif", "png", "still"]


class RenderRequest(BaseModel):
    project_id: str
    scene_id: Optional[str] = None  # None = render every scene and stitch them
    quality: Literal["preview", "final"] = "preview"
    resolution: Optional[ResolutionPreset] = None
    fps: Optional[int] = None
    format: RenderFormat = "mp4"
    transparent: bool = False
    transition: bool = True  # crossfade between scenes when stitching all scenes


class MorphPreviewRequest(BaseModel):
    project_id: str
    scene_id: str
    keyframe_id: str


class RenderJob(BaseModel):
    job_id: str
    project_id: str
    scene_id: Optional[str]
    quality: str
    mode: str = "scene"  # "scene" | "morph"
    keyframe_id: Optional[str] = None
    format: RenderFormat = "mp4"
    resolution: Optional[str] = None  # ResolutionPreset value, or None for quality default
    fps: Optional[int] = None
    transparent: bool = False
    transition: bool = True
    status: Literal["queued", "running", "done", "error"] = "queued"
    progress: int = 0
    message: str = ""
    output_path: Optional[str] = None
