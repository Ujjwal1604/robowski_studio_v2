import React from 'react';
import { useApp } from '../../context/AppContext';

export const CompareView: React.FC = () => {
  const { runsList, compareIds, setCompareIds, setView } = useApp();

  if (compareIds.length !== 2) {
    return null;
  }

  const rA = runsList.find((x) => x.id === compareIds[0]);
  const rB = runsList.find((x) => x.id === compareIds[1]);

  if (!rA || !rB) {
    return (
      <div className="wrap">
        <div className="card">
          <p>Selected runs were not found.</p>
          <button type="button" className="btn sm" onClick={() => setView('runs')}>
            Back to runs
          </button>
        </div>
      </div>
    );
  }

  const stA = rA.state;
  const stB = rB.state;

  const paramRows: [string, any, any][] = [
    ['Mode', stA.mode, stB.mode],
    ['Hood', stA.hood, stB.hood],
    ['Vial vol (µL)', stA.vialVolume, stB.vialVolume],
    ['Threshold (µL)', stA.threshold, stB.threshold],
    ['Dilution factor', stA.dilutionFactor, stB.dilutionFactor],
    ['Solvent', stA.reactionSolvent, stB.reactionSolvent],
    ['Leftover (mL)', stA.leftoverMl, stB.leftoverMl],
    ['Reactions', rA.reactions, rB.reactions],
    ['Plates', rA.plates, rB.plates],
  ];

  const nf = (v: any, d = 2) =>
    Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: d }) : '-';

  const fmt = (v: any) =>
    v == null || v === '' ? <span className="hint">—</span> : String(v);

  const reagsA = stA.reagents || [];
  const reagsB = stB.reagents || [];
  const maxR = Math.max(reagsA.length, reagsB.length);

  return (
    <div className="wrap">
      <div className="card" style={{ marginBottom: '20px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h2>Compare runs</h2>
            <p className="sub" style={{ margin: 0 }}>
              Differences are in <span style={{ color: 'var(--acc)' }}>accent colour</span> ·
              missing reagents shown in{' '}
              <span style={{ color: 'var(--bad)', opacity: 0.6 }}>red, faded</span>.
            </p>
          </div>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setCompareIds([]);
              setView('runs');
            }}
          >
            Back to runs
          </button>
        </div>

        <div style={{ display: 'flex', gap: '20px', marginTop: '12px' }}>
          <div style={{ flex: 1 }}>
            <b>{rA.name}</b>
            <div className="hint">
              {rA.mode} · {new Date(rA.updated || 0).toLocaleDateString()}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <b>{rB.name}</b>
            <div className="hint">
              {rB.mode} · {new Date(rB.updated || 0).toLocaleDateString()}
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '20px' }}>
        <h2>Parameters</h2>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Setting</th>
                <th>{rA.name}</th>
                <th>{rB.name}</th>
              </tr>
            </thead>
            <tbody>
              {paramRows.map(([label, a, b]) => {
                const isDiff = String(a) !== String(b);
                const diffStyle = isDiff
                  ? { color: 'var(--acc)', fontWeight: 600 }
                  : undefined;
                return (
                  <tr key={label}>
                    <td>{label}</td>
                    <td style={diffStyle}>{fmt(a)}</td>
                    <td style={diffStyle}>{fmt(b)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Reagents</h2>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{rA.name} code</th>
                <th>{rB.name} code</th>
                <th>{rA.name} name</th>
                <th>{rB.name} name</th>
                <th>{rA.name} MM</th>
                <th>{rB.name} MM</th>
                <th>{rA.name} stock</th>
                <th>{rB.name} stock</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: maxR }, (_, i) => {
                const ra = reagsA[i];
                const rb = reagsB[i];
                const ca = ra ? ra.code : '';
                const cb = rb ? rb.code : '';
                const na = ra ? ra.name : '';
                const nb = rb ? rb.name : '';
                const ma = ra ? nf(ra.molarMass, 2) : '';
                const mb = rb ? nf(rb.molarMass, 2) : '';
                const sa = ra ? nf(ra.stock, 1) : '';
                const sb = rb ? nf(rb.stock, 1) : '';

                const missingStyle = { color: 'var(--bad)', opacity: 0.6 };
                const diffStyle = { color: 'var(--acc)', fontWeight: 600 };

                const caStyle = !ra ? missingStyle : ca !== cb ? diffStyle : undefined;
                const cbStyle = !rb ? missingStyle : ca !== cb ? diffStyle : undefined;
                const naStyle = !ra ? missingStyle : na !== nb ? diffStyle : undefined;
                const nbStyle = !rb ? missingStyle : na !== nb ? diffStyle : undefined;
                const maStyle = !ra ? missingStyle : ma !== mb ? diffStyle : undefined;
                const mbStyle = !rb ? missingStyle : ma !== mb ? diffStyle : undefined;
                const saStyle = !ra ? missingStyle : sa !== sb ? diffStyle : undefined;
                const sbStyle = !rb ? missingStyle : sa !== sb ? diffStyle : undefined;

                return (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td style={caStyle}>{fmt(ca)}</td>
                    <td style={cbStyle}>{fmt(cb)}</td>
                    <td style={naStyle}>{fmt(na)}</td>
                    <td style={nbStyle}>{fmt(nb)}</td>
                    <td style={maStyle}>{fmt(ma)}</td>
                    <td style={mbStyle}>{fmt(mb)}</td>
                    <td style={saStyle}>{fmt(sa)}</td>
                    <td style={sbStyle}>{fmt(sb)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
