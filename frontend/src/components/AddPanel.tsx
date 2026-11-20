import { useRef, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useCanvasStore } from '../store/canvasStore';
import {
  createLatex, createText, createMatrix, createRectangle, createCircle, createEllipse,
  createPolygon, createLine, createArrow, createDoubleArrow, createDashedLine,
  createAxes, createNumberLine, createNumberPlane, createFunctionPlot,
  createParametric, createImplicit, createVectorField,
  createVector, createAngle, createBrace, createImage, createNumber, createHistogram,
} from '../store/objectFactory';
import { newId, objectDefaultFor, withDefaults } from '../store/objectFactory';
import { uploadImageAsset } from '../api/client';
import type { SceneObject } from '../types/ir';

const LINE_SUBTYPES = ['line', 'arrow', 'dashed_line', 'double_arrow'];

// An Add-panel tile's content: glyph chip + label. The glyph is decorative, so
// the button's accessible name is just the label ("Circle", "Expression"…).
function tile(icon: string, label: string) {
  return (
    <>
      <span className="add-panel__icon" aria-hidden="true">{icon}</span>
      <span className="add-panel__label">{label}</span>
    </>
  );
}

// naturalWidth / naturalHeight of an image file (1 if it can't be decoded —
// the backend will still validate the extension on upload).
function measureAspect(file: File): Promise<number> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(1); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

export function AddPanel() {
  const addObject = useProjectStore(s => s.addObject);
  const updateSettings = useProjectStore(s => s.updateSettings);
  const selectObject = useProjectStore(s => s.selectObject);
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const scene = project?.scenes.find(s => s.id === selectedSceneId);

  // Every creation path goes through `mk` so the project's Object Defaults
  // (Settings → Object Defaults) land on the object — including the ones the
  // user didn't click for directly, like the Axes an Implicit plot needs.
  // It also places the object at the centre of the canvas view, so it appears
  // where you're looking even after panning / zooming away from the origin
  // (points are local to `position`, so this moves lines / polygons whole).
  // Axes-bound graphs, angles and braces are skipped: they're drawn from what
  // they attach to, and their own position is never used.
  const mk = (key: string, obj: SceneObject): SceneObject => {
    const out = withDefaults(obj, objectDefaultFor(project, key));
    const p = out.props as { axes_ref?: string; subtype?: string };
    const attached = (out.type === 'graph' && !!p.axes_ref)
      || (out.type === 'geometry' && (p.subtype === 'brace' || p.subtype === 'angle'));
    if (!attached) out.position = { ...useCanvasStore.getState().viewCenter };
    return out;
  };

  const add = (key: string, factory: () => SceneObject) => {
    const obj = mk(key, factory());
    addObject(obj);
    selectObject(obj.id);
  };

  // Ensure an Axes exists, returning its id (creates one if needed).
  const ensureAxes = (): string => {
    const existing = scene?.objects.find(o => o.type === 'coordinate_system' && (o.props as any).subtype === 'axes');
    if (existing) return existing.id;
    const axes = mk('axes', createAxes());
    addObject(axes);
    return axes.id;
  };

  const addOnAxes = (key: string, factory: (axesId: string) => SceneObject) => {
    const obj = mk(key, factory(ensureAxes()));
    addObject(obj);
    selectObject(obj.id);
  };

  // Angle needs two lines sharing a vertex. Reuse existing lines if there are
  // two; otherwise create a fresh pair that forms a clear angle at the origin.
  const addAngle = () => {
    const lines = (scene?.objects ?? []).filter(o => o.type === 'shape' && LINE_SUBTYPES.includes((o.props as any).subtype));
    let id1 = lines[0]?.id, id2 = lines[1]?.id;
    if (!id1 || !id2) {
      // The angle's own arms are Lines, so they take the Line defaults — but not
      // the endpoints, which have to form the angle.
      const l1 = mk('line', createLine()); l1.id = newId(); (l1.props as any).start_point = { x: 0, y: 0 }; (l1.props as any).end_point = { x: 2.5, y: 0 }; l1.name = 'Angle line 1';
      const l2 = mk('line', createLine()); l2.id = newId(); (l2.props as any).start_point = { x: 0, y: 0 }; (l2.props as any).end_point = { x: 1.8, y: 1.8 }; l2.name = 'Angle line 2';
      addObject(l1); addObject(l2);
      id1 = l1.id; id2 = l2.id;
    }
    const ang = mk('angle', createAngle(id1, id2));
    addObject(ang);
    selectObject(ang.id);
  };
  const addBrace = () => {
    const target = (scene?.objects ?? []).find(o => o.id === useProjectStore.getState().selectedObjectIds[0]) ?? scene?.objects.find(o => o.type !== 'geometry');
    add('brace', () => createBrace(target?.id ?? ''));
  };

  // Image: pick a file → upload it to the project's assets → add the object.
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const onImagePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file || !project) return;
    setUploading(true);
    try {
      const aspect = await measureAspect(file);
      const info = await uploadImageAsset(project.id, file);
      // Width is passed in rather than merged after, so the height stays derived
      // from it and the image isn't stretched (see createImage).
      const w = objectDefaultFor(project, 'image')?.props?.width;
      add('image', () => createImage(info.filename, info.name, aspect, typeof w === 'number' ? w : 4));
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      alert(`Image upload failed: ${detail ?? (err instanceof Error ? err.message : String(err))}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="add-panel">
      <h3 className="panel-title">Add Object</h3>

      <div className="add-panel__group">
        <span className="add-panel__cat">Text &amp; Math</span>
        <button className="btn add-panel__btn" onClick={() => add('latex_text', createLatex)}>{tile('∑', 'Expression')}</button>
        <button className="btn add-panel__btn" onClick={() => add('text', createText)}>{tile('T', 'Text')}</button>
        <button className="btn add-panel__btn" onClick={() => add('matrix', createMatrix)}>{tile('⊞', 'Matrix')}</button>
        <button className="btn add-panel__btn" onClick={() => add('number', createNumber)}>{tile('#', 'Number')}</button>
      </div>

      <div className="add-panel__group">
        <span className="add-panel__cat">Shapes</span>
        <button className="btn add-panel__btn" onClick={() => add('rectangle', createRectangle)}>{tile('▭', 'Rectangle')}</button>
        <button className="btn add-panel__btn" onClick={() => add('circle', createCircle)}>{tile('◯', 'Circle')}</button>
        <button className="btn add-panel__btn" onClick={() => add('ellipse', createEllipse)}>{tile('⬭', 'Ellipse')}</button>
        <button className="btn add-panel__btn" onClick={() => add('polygon', createPolygon)}>{tile('△', 'Polygon')}</button>
        <button className="btn add-panel__btn" onClick={() => add('line', createLine)}>{tile('╱', 'Line')}</button>
        <button className="btn add-panel__btn" onClick={() => add('arrow', createArrow)}>{tile('→', 'Arrow')}</button>
        <button className="btn add-panel__btn" onClick={() => add('double_arrow', createDoubleArrow)}>{tile('↔', 'Double Arrow')}</button>
        <button className="btn add-panel__btn" onClick={() => add('dashed_line', createDashedLine)}>{tile('┄', 'Dashed Line')}</button>
      </div>

      <div className="add-panel__group">
        <span className="add-panel__cat">Coordinates</span>
        <button className="btn add-panel__btn" onClick={() => add('axes', createAxes)}>{tile('✛', 'Axes')}</button>
        <button className="btn add-panel__btn" onClick={() => add('number_line', createNumberLine)}>{tile('⊢', 'Number Line')}</button>
        <button className="btn add-panel__btn" onClick={() => add('number_plane', createNumberPlane)}>{tile('▦', 'Number Plane')}</button>
      </div>

      <div className="add-panel__group">
        <span className="add-panel__cat">Graph</span>
        <button className="btn add-panel__btn" onClick={() => addOnAxes('function_plot', createFunctionPlot)}>{tile('∿', 'Function Plot')}</button>
        <button className="btn add-panel__btn" onClick={() => addOnAxes('parametric', createParametric)}>{tile('⟳', 'Parametric')}</button>
        <button className="btn add-panel__btn" onClick={() => addOnAxes('implicit', createImplicit)}>{tile('◔', 'Implicit')}</button>
        <button className="btn add-panel__btn" onClick={() => addOnAxes('histogram', createHistogram)}>{tile('▥', 'Histogram')}</button>
        <button className="btn add-panel__btn" onClick={() => add('vector_field', createVectorField)}>{tile('⇶', 'Vector Field')}</button>
      </div>

      <div className="add-panel__group">
        <span className="add-panel__cat">Geometry</span>
        <button className="btn add-panel__btn" onClick={() => add('vector', createVector)}>{tile('↗', 'Vector')}</button>
        <button className="btn add-panel__btn" onClick={addAngle}>{tile('∠', 'Angle')}</button>
        <button className="btn add-panel__btn" onClick={addBrace}>{tile('⏟', 'Brace')}</button>
      </div>

      <div className="add-panel__group">
        <span className="add-panel__cat">Media</span>
        <button className="btn add-panel__btn" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? tile('⏳', 'Uploading…') : tile('🖼', 'Image')}
        </button>
        <input ref={fileInput} type="file" accept=".png,.jpg,.jpeg,.webp,.bmp" style={{ display: 'none' }} onChange={onImagePicked} />
      </div>

      {/* Same setting as Settings → Project → Animation (settings.auto_intro). */}
      <label className="field field--check add-panel__auto"
        title="Each new object gets a Write / Create / Fade In keyframe right after the scene's last animation, so the scene builds up in the order you add things">
        <input type="checkbox" checked={!!project?.settings.auto_intro}
          onChange={e => updateSettings({ auto_intro: e.target.checked })} />
        <span className="field__label" style={{ margin: 0 }}>Animate new objects in</span>
      </label>
    </div>
  );
}
