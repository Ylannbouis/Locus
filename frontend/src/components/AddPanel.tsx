import { useProjectStore } from '../store/projectStore';
import {
  createLatex, createMatrix, createRectangle, createCircle, createEllipse,
  createPolygon, createLine, createArrow, createDoubleArrow, createDashedLine,
  createAxes, createNumberLine, createNumberPlane, createFunctionPlot,
} from '../store/objectFactory';
import type { SceneObject } from '../types/ir';

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

  const addPlot = () => {
    let axesId: string;
    const existing = scene?.objects.find(o => o.type === 'coordinate_system' && (o.props as any).subtype === 'axes');
    if (existing) {
      axesId = existing.id;
    } else {
      const axes = createAxes();
      addObject(axes);
      axesId = axes.id;
    }
    const plot = createFunctionPlot(axesId);
    addObject(plot);
    selectObject(plot.id);
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
        <button className="btn add-panel__btn" onClick={addPlot}>∿ Function Plot</button>
      </div>
    </div>
  );
}
