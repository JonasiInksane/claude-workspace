// Today (#today), the start screen. A stub until wave 3b (UI-TODAY) replaces this file: it
// shows the old dashboard (the render of views/home.js) under the Today title, so the app
// stays usable meanwhile. home.js stays registered but is no longer in the nav.
import home from './home.js';

function render(el, ctx) {
  home.render(el, ctx);
  const title = el.querySelector('.view-head h2');
  if (title) title.textContent = 'Today';
}

export default {
  id: 'today',
  label: 'Today',
  icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  render,
};
