import { test } from "node:test";
import assert from "node:assert/strict";
import { softClip } from "./limiter";
import { channelOf, louderGain, mixVolumes, panLabel, withChannel } from "./mix";

test("older songs: the volumes and the layers off carry over", () => {
  const s = { mix: { beat: 0.5, "lane:Lead": 1.2 }, mixOff: ["Double"] };
  assert.deepEqual(channelOf(s, "beat"), { vol: 0.5, pan: 0, mute: false, solo: false });
  assert.equal(channelOf(s, "lane:Double").mute, true);
  const next = withChannel(s, "lane:Lead", { pan: -0.4 });
  assert.equal(next.mix, undefined);
  assert.equal(next.mixOff, undefined);
  assert.deepEqual(next.mixer!["lane:Lead"], { vol: 1.2, pan: -0.4, mute: false, solo: false });
  assert.equal(next.mixer!["lane:Double"].mute, true);
  assert.equal(next.mixer!.beat.vol, 0.5);
});

test("solo: only the soloed channels play; mute wins", () => {
  const s = { mixer: { "lane:Lead": { solo: true, vol: 0.8 }, beat: { solo: true, mute: true } } };
  const v = mixVolumes(s, ["Lead", "Double"]);
  assert.equal(v["lane:Lead"], 0.8);
  assert.equal(v["lane:Double"], 0);
  assert.equal(v.beat, 0);
  assert.equal(v.flow, 0);
  assert.equal(panLabel(-0.4), "L 40");
  assert.equal(panLabel(0.01), "C");
});

test("a quiet take made as loud as it can be, never past the limit", () => {
  assert.equal(louderGain([0.1, 0.2, 0.05]), 4.45 > 4 ? 4 : 4.45);
  assert.equal(louderGain([0.445]), 2);
  assert.equal(louderGain([0, 0.001]), null);
});

test("the limiter: quiet stays, loud bends towards full scale and never past it", () => {
  assert.equal(softClip(0.5), 0.5);
  assert.equal(softClip(-0.89), -0.89);
  assert.ok(softClip(1.2) < 1 && softClip(1.2) > 0.95);
  assert.ok(softClip(3.57) <= 1 && softClip(3.57) > softClip(1.2));
  assert.ok(softClip(-3.57) >= -1);
});
