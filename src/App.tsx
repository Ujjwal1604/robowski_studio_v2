import React, { useEffect } from 'react';
import { useApp } from './context/AppContext';
import {
  Header,
  StepsNav,
  SummaryStrip,
  SetupView,
  CombinationsView,
  DeckView,
  ExportView,
  TlcView,
  RunsView,
  CompareView,
  PreviewModal,
  Toast,
  Tooltip,
} from './components';

export const App: React.FC = () => {
  const { view, saveRun, closePreview, previewModal } = useApp();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRun(false);
      }
      if (e.key === 'Escape' && previewModal) {
        closePreview();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveRun, previewModal, closePreview]);

  return (
    <div id="app">
      <Header />
      {view !== 'runs' && view !== 'compare' && (
        <div className="stepsbar">
          <StepsNav />
        </div>
      )}

      {view !== 'runs' && view !== 'compare' && <SummaryStrip />}

      <main id="main">
        {view === 'setup' && <SetupView />}
        {view === 'combos' && <CombinationsView />}
        {view === 'deck' && <DeckView />}
        <div style={{ display: view === 'tlc' ? 'block' : 'none' }}>
          <TlcView />
        </div>
        {view === 'export' && <ExportView />}
        {view === 'runs' && <RunsView />}
        {view === 'compare' && <CompareView />}
      </main>

      <PreviewModal />
      <Toast />
      <Tooltip />
    </div>
  );
};
