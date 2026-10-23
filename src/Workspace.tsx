import { lazy, Suspense, useState } from 'react';
import { BatchWorkspace } from './components/BatchWorkspace';

const AdvancedWorkspace = lazy(() => import('./App'));

export default function Workspace() {
  const [advanced, setAdvanced] = useState(false);
  const [hasOpenedAdvanced, setHasOpenedAdvanced] = useState(false);
  return <>
    <div hidden={advanced}><BatchWorkspace onAdvanced={() => { setHasOpenedAdvanced(true); setAdvanced(true); }} /></div>
    {hasOpenedAdvanced && <div hidden={!advanced}>
      <div className="bw-legacy-nav"><button onClick={() => setAdvanced(false)}>← 返回批次工作台</button> 旧版独立工作区</div>
      <Suspense fallback={<p>正在打开高级工作台…</p>}><AdvancedWorkspace /></Suspense>
    </div>}
  </>;
}
