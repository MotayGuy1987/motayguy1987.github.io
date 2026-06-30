import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Header from './components/Header';
import Home from './pages/Home';
import MatchPlayer from './pages/MatchPlayer';
import Diagnostics from './pages/Diagnostics';

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-slate-950 text-white">
        <Header />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/match/:uid" element={<MatchPlayer />} />
          <Route path="/diagnostics" element={<Diagnostics />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
