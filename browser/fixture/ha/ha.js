// Anonymised fixture behaviour: every control counts a "mutation" if (and only if) its handler runs. The read-only guard must keep it at 0.
window.__mutations = 0;
document.addEventListener('DOMContentLoaded', () => {
  for (const el of document.querySelectorAll('[data-mutates]')) {
    for (const type of ['click', 'change', 'input']) el.addEventListener(type, () => { window.__mutations++; });
  }
  const cookie = document.cookie; // proves nothing about auth; the fixture is public and anonymised
  void cookie;
});
