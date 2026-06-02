/* misen.space — small client-side script.
   - Rotates the wordmark suffix through the app suite, with matching color.
   - Wires the email signup form to /api/signup.
*/

(function () {
  'use strict';

  // ---------- Rotating wordmark suffix ----------
  const ROTATIONS = [
    { word: 'kitchen', color: '#C97E0C' },
    { word: 'inbox',   color: '#D85A30' },
    { word: 'garden',  color: '#256040' },
    { word: 'day',     color: '#2C2C2A' },
    { word: 'studio',  color: '#BA7517' },
    { word: 'media',   color: '#7F77DD' },
    { word: 'score',   color: '#D4537E' },
    { word: 'read',    color: '#2c4a6b' },
    { word: 'map',     color: '#6b7547' },
    { word: 'sketch',  color: '#b8541e' },
    { word: 'diary',   color: '#9a6f44' },
    { word: 'font',    color: '#5a4eb8' },
  ];

  const rotatingEl = document.getElementById('rotating');
  if (rotatingEl) {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!prefersReduced) {
      let i = 0;
      setInterval(() => {
        i = (i + 1) % ROTATIONS.length;
        const r = ROTATIONS[i];
        rotatingEl.style.opacity = '0';
        setTimeout(() => {
          rotatingEl.textContent = r.word;
          rotatingEl.style.color = r.color;
          rotatingEl.style.opacity = '1';
        }, 200);
      }, 1800);
      rotatingEl.style.transition = 'opacity 200ms ease, color 500ms ease';
    }
  }

  // ---------- Year ----------
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // ---------- Signup form ----------
  const form = document.getElementById('signup-form');
  const msg  = document.getElementById('signup-msg');
  const btn  = document.getElementById('signup-btn');

  if (form && msg && btn) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (form.email.value || '').trim();
      msg.classList.remove('is-error');

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msg.textContent = 'That email doesn\'t look quite right.';
        msg.classList.add('is-error');
        return;
      }

      btn.disabled = true;
      const originalLabel = btn.textContent;
      btn.textContent = 'Sending…';
      msg.textContent = '';

      try {
        const res = await fetch('/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok) {
          form.reset();
          msg.textContent = data.message || 'Got it — thanks. I\'ll be in touch.';
        } else if (res.status === 409) {
          msg.textContent = 'Looks like you\'re already on the list.';
        } else {
          throw new Error(data.error || 'Signup failed');
        }
      } catch (err) {
        msg.textContent = 'Couldn\'t reach the signup server. Try again in a minute?';
        msg.classList.add('is-error');
      } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  }
})();
