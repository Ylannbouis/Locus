import { DepGate } from './components/DepGate';
import { EditorShell } from './components/EditorShell';
import { ProjectHome } from './components/ProjectHome';
import { useProjectStore } from './store/projectStore';
import './App.css';

export default function App() {
  const project = useProjectStore(s => s.project);

  return (
    <DepGate>
      {project ? <EditorShell /> : <ProjectHome />}
    </DepGate>
  );
}
