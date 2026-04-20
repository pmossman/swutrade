import { BrowserRouter, Route, Routes, useLocation } from 'react-router';
import { TabBar } from './components/primitives/TabBar';
import { TradesRoute } from './routes/trades';
import { CardsRoute } from './routes/cards';
import { CommunityRoute } from './routes/community';
import { MeRoute } from './routes/me';
import { TradeCanvasRoute } from './routes/trade-canvas';
import { ProfileRoute } from './routes/profile';
import { NotFoundRoute } from './routes/not-found';

/*
 * Trade canvas + profile + settings render "standalone" — no tab bar,
 * full-focus. Four primary tabs share the tab-bar chrome.
 */
const STANDALONE_PATTERNS = [/^\/s\//, /^\/u\//, /^\/settings/, /^\/list/];

function Shell() {
  const location = useLocation();
  const isStandalone = STANDALONE_PATTERNS.some((p) => p.test(location.pathname));
  return (
    <>
      <Routes>
        <Route path="/" element={<TradesRoute />} />
        <Route path="/cards" element={<CardsRoute />} />
        <Route path="/community" element={<CommunityRoute />} />
        <Route path="/me" element={<MeRoute />} />
        <Route path="/s/:code" element={<TradeCanvasRoute />} />
        <Route path="/u/:handle" element={<ProfileRoute />} />
        <Route path="*" element={<NotFoundRoute />} />
      </Routes>
      {isStandalone ? null : <TabBar />}
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
