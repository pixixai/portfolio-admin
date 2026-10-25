import assert from 'node:assert/strict';
import { origamiPose, projectOrigami } from '../origami-hero.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
for (let s = 0; s <= 20; s++) {
  for (let h = 0; h <= 20; h++) {
    const pose = origamiPose(s / 20, h / 20);
    assert.equal(pose.panels.length, 6);
    assert.ok(pose.fold >= 8 && pose.fold <= 57);
    assert.ok(pose.width <= 6 && pose.width > 3);
    pose.panels.forEach((panel, i) => {
      assert.ok(Object.values(panel).every(Number.isFinite));
      if (i === 5) return;
      const angle = panel.angle * Math.PI / 180;
      close(panel.x + Math.cos(angle), pose.panels[i + 1].x);
      close(panel.z - Math.sin(angle), pose.panels[i + 1].z);
    });
    if (s < 20) assert.ok(origamiPose((s + 1) / 20, h / 20).width >= pose.width);
    if (h < 20) assert.ok(origamiPose(s / 20, (h + 1) / 20).width >= pose.width);
    for (const width of [320, 600, 1024]) {
      const windows = projectOrigami(pose, { width, height: 460, leaf: width / 7, paperHeight: 380 }, 12, -18, s / 20);
      windows.forEach((corners, i) => {
        assert.ok(corners.every(point => Object.values(point).every(Number.isFinite)));
        if (i === 5) return;
        close(corners[1].x, windows[i + 1][0].x);
        close(corners[1].y, windows[i + 1][0].y);
        close(corners[2].x, windows[i + 1][3].x);
        close(corners[2].y, windows[i + 1][3].y);
      });
    }
  }
}
assert.ok(origamiPose(.8, 0).width > origamiPose(0, 0).width, 'Scroll retains a partially unfolded shape after hover ends');
close(origamiPose(.6, 1).fold, origamiPose(0, 1).fold);
assert.deepEqual(origamiPose(-2, -3), origamiPose(0, 0));
assert.deepEqual(origamiPose(2, 3), origamiPose(1, 1));
console.log('PASS: connected fold geometry, bounded angles, monotonic unfolding, combined hover/scroll state and continuous refraction windows.');
