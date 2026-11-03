import React from 'react';
import { useApp } from '../../context/AppContext';

export const Toast: React.FC = () => {
  const { toastState, clearToast } = useApp();

  if (!toastState) return null;

  return (
    <div className="toast" role="status">
      <span>{toastState.msg}</span>
      {toastState.undo && (
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            if (toastState.undo) toastState.undo();
            clearToast();
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
};
