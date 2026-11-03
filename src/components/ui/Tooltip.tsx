import React, { useEffect, useRef } from 'react';

export const Tooltip: React.FC = () => {
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tip = tipRef.current;
    if (!tip) return;

    let activeEl: HTMLElement | null = null;

    const positionTip = (e: MouseEvent) => {
      if (!tip || tip.style.display === 'none') return;
      const pad = 12;
      const w = tip.offsetWidth || 260;
      const h = tip.offsetHeight || 100;
      let x = e.clientX + 14;
      let y = e.clientY + 14;

      if (x + w > window.innerWidth - pad) {
        x = Math.max(pad, e.clientX - w - 14);
      }
      if (y + h > window.innerHeight - pad) {
        y = Math.max(pad, e.clientY - h - 14);
      }
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    };

    const handleMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tipHost = target.closest('[data-tip]') as HTMLElement | null;
      if (!tipHost) {
        if (activeEl) {
          activeEl = null;
          tip.style.display = 'none';
        }
        return;
      }

      activeEl = tipHost;
      const rawHtml = tipHost.getAttribute('data-tip') || '';
      if (!rawHtml) {
        tip.style.display = 'none';
        return;
      }

      tip.innerHTML = rawHtml;
      tip.style.display = 'block';
      positionTip(e);
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (activeEl && tip.style.display !== 'none') {
        positionTip(e);
      }
    };

    const handleMouseOut = (e: MouseEvent) => {
      const related = e.relatedTarget as HTMLElement | null;
      if (activeEl && (!related || !activeEl.contains(related))) {
        activeEl = null;
        tip.style.display = 'none';
      }
    };

    const handleScrollOrTouch = () => {
      if (tip) tip.style.display = 'none';
      activeEl = null;
    };

    document.addEventListener('mouseover', handleMouseOver, { passive: true });
    document.addEventListener('mousemove', handleMouseMove, { passive: true });
    document.addEventListener('mouseout', handleMouseOut, { passive: true });
    window.addEventListener('scroll', handleScrollOrTouch, { passive: true });

    return () => {
      document.removeEventListener('mouseover', handleMouseOver);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseout', handleMouseOut);
      window.removeEventListener('scroll', handleScrollOrTouch);
    };
  }, []);

  return <div id="tip" ref={tipRef} className="tip" style={{ display: 'none' }} />;
};
