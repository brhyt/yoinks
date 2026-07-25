import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {buildChoices, type VideoInfo} from './ytdlp.js'

/**
 * Regression lock on shipped video capture.
 *
 * People installed yoinks to download videos. As the extractor registry grows
 * around it, these labels and args are the contract that must not drift — a
 * change here means the picker a 0.3.1 user knows has silently moved under
 * them. If this test fails and the change was deliberate, update the literals
 * in the same commit that explains why.
 */

const info = JSON.parse(
  fs.readFileSync(new URL('./__fixtures__/youtube-info.json', import.meta.url), 'utf8'),
) as VideoInfo

test('picker rows are byte-identical to 0.3.1', () => {
  assert.deepEqual(buildChoices(info), [
    {
      kind: 'video',
      label: '1080p · mp4 · ~46 MB',
      args: ['-f', 'bv*[height=1080]+ba/b[height=1080]/bv*[height<=1080]+ba/b', '--merge-output-format', 'mp4'],
    },
    {
      kind: 'video',
      label: '720p · mp4 · ~24 MB',
      args: ['-f', 'bv*[height=720]+ba/b[height=720]/bv*[height<=720]+ba/b', '--merge-output-format', 'mp4'],
    },
    {
      kind: 'video',
      label: '480p · mp4 · ~14 MB',
      args: ['-f', 'bv*[height=480]+ba/b[height=480]/bv*[height<=480]+ba/b', '--merge-output-format', 'mp4'],
    },
    {
      kind: 'video',
      label: '360p · mp4 · ~5.7 MB',
      args: ['-f', 'bv*[height=360]+ba/b[height=360]/bv*[height<=360]+ba/b', '--merge-output-format', 'mp4'],
    },
    {
      kind: 'audio',
      label: 'audio only · mp3 · ~3.3 MB',
      args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
    },
  ])
})

test('a muxed format wins its height when it outscores the video-only one', () => {
  // 720p has both 136 (video-only, tbr 2000) and 22 (muxed, tbr 2200). The
  // muxed one wins on score, so its size is NOT summed with the audio track.
  const row = buildChoices(info).find(c => c.label.startsWith('720p'))
  assert.equal(row?.label, '720p · mp4 · ~24 MB')
})

test('sizes fall back to filesize_approx', () => {
  // 480p (135) only carries filesize_approx — 11 MB + 3.5 MB of audio.
  const row = buildChoices(info).find(c => c.label.startsWith('480p'))
  assert.equal(row?.label, '480p · mp4 · ~14 MB')
})

test('heights are unique and descending', () => {
  const heights = buildChoices(info)
    .filter(c => c.kind === 'video')
    .map(c => Number.parseInt(c.label, 10))
  assert.deepEqual(heights, [1080, 720, 480, 360])
})

test('audio-only is always offered, and always last', () => {
  const choices = buildChoices(info)
  assert.equal(choices.at(-1)?.kind, 'audio')
  assert.equal(choices.filter(c => c.kind === 'audio').length, 1)
})

test('a format list with no video still yields a usable choice', () => {
  const audioOnly: VideoInfo = {
    title: 'podcast episode',
    formats: info.formats!.filter(f => f.vcodec === 'none'),
  }
  const choices = buildChoices(audioOnly)
  assert.equal(choices[0]?.label, 'best available · mp4')
  assert.equal(choices.at(-1)?.kind, 'audio')
})

test('an empty format list does not throw', () => {
  const choices = buildChoices({title: 'nothing'})
  assert.equal(choices.length, 2)
  assert.equal(choices[0]?.label, 'best available · mp4')
})
