// js/firstaid.js
// The First Aid Guide: one short, static, read-only text supplied by the project owner, rendered with el()/textContent
// only. It makes no API or socket call and keeps no data, so it works signed out and for every role.
// The wording is shown exactly as supplied (tests/firstaid_content.test.js holds the exact text); this module only lays
// it out. It is general guidance, not a clinical protocol.

import { el, mount } from './dom.js';

export const FIRST_AID_NOTE = 'General guidance only. Call 112 in an emergency.';

export const FIRST_AID_GUIDE = Object.freeze({
  title: '1. What to do immediately after an accident',
  sections: Object.freeze([
    Object.freeze({
      heading: '1. Ensure your own safety',
      items: Object.freeze([
        'Stop in a safe place.',
        'Switch on hazard lights.',
        'Watch out for traffic, fire, leaking fuel or electrical hazards.',
        'Do not put yourself in danger.'
      ])
    }),
    Object.freeze({
      heading: '2. Call emergency services',
      items: Object.freeze([
        'In India, dial 112 for emergency assistance.',
        'Ask someone to call an ambulance.',
        'Give your exact location, number of injured people and type of accident.'
      ])
    }),
    Object.freeze({
      heading: '3. Check the injured person',
      items: Object.freeze([
        'Check whether they respond when you speak to them.',
        'Check whether they are breathing normally.',
        'Look for severe bleeding.',
        'Do not shake them or unnecessarily move their neck.'
      ])
    }),
    Object.freeze({
      heading: '4. Provide appropriate first aid',
      items: Object.freeze([
        'Control bleeding.',
        "Protect the person's airway.",
        'Keep them warm.',
        "Follow the emergency operator's instructions."
      ])
    })
  ])
});

/** The guide as plain text, in the layout it was supplied in (title, numbered headings, "   - " items). */
export function firstAidPlainText(guide = FIRST_AID_GUIDE) {
  return [guide.title, ...guide.sections.flatMap(s => [s.heading, ...s.items.map(item => `   - ${item}`)])].join('\n');
}

/**
 * Render the guide into `container` (later calls re-render). `idPrefix` keeps heading ids unique when the guide appears
 * twice in the page (the staff tab and the sign-in dialog).
 */
export function renderFirstAid(container, { idPrefix = 'fa' } = {}) {
  if (!container) return;
  const g = FIRST_AID_GUIDE;
  mount(container,
    el('p', { class: 'fa-disclaimer', role: 'note' }, 'General guidance only. ', el('a', { href: 'tel:112', class: 'fa-call-link' }, 'Call 112'), ' in an emergency.'),
    el('article', { class: 'fa-guide', 'aria-labelledby': `${idPrefix}-title` },
      el('h3', { id: `${idPrefix}-title`, class: 'fa-guide-title' }, g.title),
      g.sections.map((s, i) => el('section', { class: 'fa-step', 'aria-labelledby': `${idPrefix}-s${i + 1}` },
        el('h4', { id: `${idPrefix}-s${i + 1}`, class: 'fa-step-title' }, s.heading),
        el('ul', { class: 'fa-step-items' }, s.items.map(item => el('li', {}, item)))))));
}
