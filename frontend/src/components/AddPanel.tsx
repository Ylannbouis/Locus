import { useRef, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import {
  createLatex, createMatrix, createRectangle, createCircle, createEllipse,
  createPolygon, createLine, createArrow, createDoubleArrow, createDashedLine,
  createAxes, createNumberLine, createNumberPlane, createFunctionPlot,
  createParametric, createImplicit, createVectorField,
  createVector, createAngle, createBrace, createImage,
} from '../store/objectFactory';
import { newId } from '../store/objectFactory';
import { uploadImageAsset } from '../api/client';
import type { SceneObject } from '../types/ir';

const LINE_SUBTYPES = ['line', 'arrow', 'dashed_line', 'double_arrow'];

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
  const selectObject = useProjectStore(s => s.selectObject);
  const project = useProjectStore(s => s.project);
  const selectedSceneId = useProjectStore(s => s.selectedSceneId);
  const scene = project?.scenes.find(s => s.id === selectedSceneId);

  const add = (factory: () => SceneObject) => {
    const obj = factory();
    addObject(obj);
    selectObject(obj.id);
  };

  // Ensure an Axes exists, returning its id (creates one if needed).
  const ensureAxes = (): string => {
    const existing = scene?.objects.find(o => o.type === 'coordinate_system' && (o.props as any).subtype === 'axes');
    if (existing) return existing.id;
    const axes = createAxes();
    addObject(axes);
    return axes.id;
  };

  const addOnAxes = (factory: (axesId: string) => SceneObject) => {
    const obj = factory(ensureAxes());
    addObject(obj);
    selectObject(obj.id);
  };

  // Angle needs two lines sharing a vertex. Reuse existing lines if there are
  // two; otherwise create a fresh pair that forms a clear angle at the origin.
  const addAngle = () => {
    const lines = (scene?.objects ?? []).filter(o => o.type === 'shape' && LINE_SUBTYPES.includes((o.props as any).subtype));
    let id1 = lines[0]?.id, id2 = lines[1]?.id;
    if (!id1 || !id2) {
      const l1 = createLine(); l1.id = newId(); (l1.props as any).start_point = { x: 0, y: 0 }; (l1.props as any).end_point = { x: 2.5, y: 0 }; l1.name = 'Angle line 1';
      const l2 = createLine(); l2.id = newId(); (l2.props as any).start_point = { x: 0, y: 0 }; (l2.props as any).end_point = { x: 1.8, y: 1.8 }; l2.name = 'Angle line 2';
      addObject(l1); addObject(l2);
      id1 = l1.id; id2 = l2.id;
    }
    const ang = createAngle(id1, id2);
    addObject(ang);
    selectObject(ang.id);
  };
  const addBrace = () => {
    const target = (scene?.objects ?? []).find(o => o.id === useProjectStore.getState().selectedObjectIds[0]) ?? scene?.objects.find(o => o.type !== 'geometry');
    add(() => createBrace(target?.id ?? ''));
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
      add(() => createImage(info.filename, info.name, aspect));
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
        <span className="add-panel__cat">Text</span>
        <button className="btn add-panel__btn" onClick={() => add(createLatex)}>∑ Equation</button>
        <button className="btn add-panel__btn" onClick={() => add(createMatrix)}>⊞ Matrix</button>
      </div>

      <div className="add-panel__group">
        <span className="add-panel__cat">Shapes</span>
        <button className="btn add-panel__btn" onClick={() => add(createRectangle)}>▭ Rectangle</button>
        <button className="btn add-panel__btn" onClick={() => add(createCircle)}>◯ Circle</button>
        <button className="btn add-panel__btn" onClick={() => add(createEllipse)}>⬭ Ellipse</button>
        <button className="btn add-panel__btn" onClick={() => add(createPolygon)}>△ Polygon</button>
        <button className="btn add-panel__btn" onClick={() => add(createLine)}>╱ Line</button>
        <button className="btn add-panel__btn" onClick={() => add(createArrow)}>→ Arrow</button>
        <button className="btn add-panel__btn" onClick={() => add(createDoubleArrow)}>↔ Double Arrow</button>
        <button className="btn add-panel__btn" onClick={() => add(createDashedLine)}>┄ Dashed Line</button>
      </div>

      <div className="add-panel__group">
        <span className="add-panel__cat">Coordinates</span>
        <button className="btn add-panel__btn" onClick={() => add(createAxes)}>✛ Axes</button>
        <button className="btn add-panel__btn" onClick={() => add(createNumberLine)}>⊢ Number Line</button>
        <button className="btn add-panel__btn" onClick={() => add(createNumberPlane)}>▦ Number Plane</button>
      </div>

      <div className="add-panel__group">
        <span className="add-panel__cat">Graph</span>
        <button className="btn add-panel__btn" onClick={() => addOnAxes(createFunctionPlot)}>∿ Function Plot</button>
        <button className="btn add-panel__btn" onClick={() => addOnAxes(createParametric)}>⟳ Parametric</button>
        <button className="btn add-panel__btn" onClick={() => addOnAxes(createImplicit)}>◔ Implicit</button>
        <button className="btn add-panel__btn" onClick={() => add(createVectorField)}>⇶ Vector Field</button>
      </div>

      <div className="add-panel__group">
        <span className="add-panel__cat">Geometry</span>
        <button className="btn add-panel__btn" onClick={() => add(createVector)}>↗ Vector</button>
        <button className="btn add-panel__btn" onClick={addAngle}>∠ Angle</button>
        <button className="btn add-panel__btn" onClick={addBrace}>⏟ Brace</button>
      </div>

      <div className="add-panel__group">
        <span className="add-panel__cat">Media</span>
        <button className="btn add-panel__btn" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? '⏳ Uploading…' : '🖼 Image'}
        </button>
        <input ref={fileInput} type="file" accept=".png,.jpg,.jpeg,.webp,.bmp" style={{ display: 'none' }} onChange={onImagePicked} />
      </div>
    </div>
  );
}
