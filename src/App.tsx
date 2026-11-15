import React, { useEffect, useState } from 'react';
import { useApp } from './context/AppContext';
import {
  Header,
  StepsNav,
  SummaryStrip,
  SetupView,
  CombinationsView,
  PredictionView,
  DeckView,
  ExportView,
  TlcView,
  ElnView,
  RunsView,
  CompareView,
  PreviewModal,
  Toast,
  Tooltip,
  BottomStepper,
  CommandPalette,
} from './components';

export const App: React.FC = () => {
  const { view, saveRun, closePreview, previewModal } = useApp();
  const [mountedViews, setMountedViews] = useState<Record<string, boolean>>(() => ({
    [view]: true,
  }));

  useEffect(() => {
    setMountedViews((prev) => (prev[view] ? prev : { ...prev, [view]: true }));
  }, [view]);

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
        {mountedViews.predict && (
          <div style={{ display: view === 'predict' ? 'block' : 'none' }}>
            <PredictionView />
          </div>
        )}
        {view === 'deck' && <DeckView />}
        <div style={{ display: view === 'tlc' ? 'block' : 'none' }}>
          <TlcView />
        </div>
        {view === 'eln' && <ElnView />}
        {view === 'export' && <ExportView />}
        {view === 'runs' && <RunsView />}
        {view === 'compare' && <CompareView />}
      </main>

      <BottomStepper />
      <CommandPalette />
      <PreviewModal />
      <Toast />
      <Tooltip />
    </div>
  );
};
