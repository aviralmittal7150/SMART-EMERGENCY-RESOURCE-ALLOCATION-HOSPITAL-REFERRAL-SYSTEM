// tests/firstaid_content.test.js
// The First Aid Guide (js/firstaid.js) shows one short text supplied by the project owner. It must stay exactly as
// supplied: these checks compare it word for word. They do not judge the medicine.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { FIRST_AID_GUIDE, FIRST_AID_NOTE, firstAidPlainText } from '../js/firstaid.js';

const SUPPLIED = `1. What to do immediately after an accident
1. Ensure your own safety
   - Stop in a safe place.
   - Switch on hazard lights.
   - Watch out for traffic, fire, leaking fuel or electrical hazards.
   - Do not put yourself in danger.
2. Call emergency services
   - In India, dial 112 for emergency assistance.
   - Ask someone to call an ambulance.
   - Give your exact location, number of injured people and type of accident.
3. Check the injured person
   - Check whether they respond when you speak to them.
   - Check whether they are breathing normally.
   - Look for severe bleeding.
   - Do not shake them or unnecessarily move their neck.
4. Provide appropriate first aid
   - Control bleeding.
   - Protect the person's airway.
   - Keep them warm.
   - Follow the emergency operator's instructions.`;

test('the guide is exactly the supplied text', () => {
  assert.equal(firstAidPlainText(), SUPPLIED);
});

test('the guide has the supplied title and four sections, and nothing else', () => {
  assert.equal(FIRST_AID_GUIDE.title, '1. What to do immediately after an accident');
  assert.deepEqual(FIRST_AID_GUIDE.sections.map(s => s.heading),
    ['1. Ensure your own safety', '2. Call emergency services', '3. Check the injured person', '4. Provide appropriate first aid']);
  assert.deepEqual(FIRST_AID_GUIDE.sections.map(s => s.items.length), [4, 3, 4, 4]);
  assert.deepEqual(Object.keys(FIRST_AID_GUIDE).sort(), ['sections', 'title']);
});

test('the only extra line is the short 112 note', () => {
  assert.equal(FIRST_AID_NOTE, 'General guidance only. Call 112 in an emergency.');
});

test('the guide cannot be changed at run time', () => {
  assert.ok(Object.isFrozen(FIRST_AID_GUIDE) && Object.isFrozen(FIRST_AID_GUIDE.sections));
  for (const s of FIRST_AID_GUIDE.sections) assert.ok(Object.isFrozen(s) && Object.isFrozen(s.items));
});

test('the old multi-card guide and its sources are gone', () => {
  for (const f of ['../js/firstaid-content.js', '../js/firstaid-content.json']) {
    assert.equal(existsSync(new URL(f, import.meta.url)), false, `${f} still exists`);
  }
});
