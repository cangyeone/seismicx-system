import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomWindow, panWindow, tracePath, sampleTime } from '../src/platform/review/waveMath.ts';
test('wave zoom preserves the cursor time and clamps pan, bounds and resolution', () => {
 const bounds={start:-20,end:160},view={start:0,end:100};
 const next=zoomWindow(view,.2,.3,bounds);
 assert.equal(next.start+(next.end-next.start)*.3,30);
 assert.equal(next.end-next.start,20);
 assert.deepEqual(panWindow(next,999,bounds),{start:140,end:160});
 assert.deepEqual(zoomWindow(view,100,.5,bounds),bounds);
 assert.ok(Math.abs((zoomWindow(view,.0000001,.3,bounds).end-zoomWindow(view,.0000001,.3,bounds).start)-.1)<1e-9);
});
test('raw wave rendering connects real samples, preserves gaps and clips time', () => {
 const origin=Date.parse('2026-01-01T00:00:00Z');
 const trace={id:'XX.A..BHZ',start:'2026-01-01T00:00:00Z',sample_rate:100,npts:5,sample_stride:1,units:'counts',points:[[0,1,1],[.01,2,2],[.02,null,null],[.03,1,1],[.04,3,3]] as [number,number|null,number|null][]};
 const path=tracePath(trace,origin,{start:0,end:.03},0,300,50,20);
 assert.equal((path.match(/M/g)||[]).length,2);
 assert.equal((path.match(/L/g)||[]).length,1);
 assert.ok(!path.includes('400'));
 assert.equal(sampleTime(.026,trace,origin),.03);
});
