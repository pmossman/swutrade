import { useParams } from 'react-router';
import { Screen } from '../components/primitives/Screen';
import { EmptyState } from '../components/primitives/EmptyState';

export function TradeCanvasRoute() {
  const { code } = useParams<{ code: string }>();
  return (
    <Screen title="Trade" withTabBar={false}>
      <EmptyState
        title={`Canvas for ${code ?? '(no code)'}`}
        body="Trade canvas ships in sub-phase 1d. This placeholder confirms the /s/:code route renders."
      />
    </Screen>
  );
}
