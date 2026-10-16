import { readFileSync } from 'node:fs';

export function fixture(name) {
  return JSON.parse(readFileSync(new URL('../../packages/sdk/tests/fixtures/' + name + '.json', import.meta.url), 'utf8')).interactions;
}

export function strict(interactions) {
  return interactions.map(item => ({
    ...item, request: { ...item.request, strict: true,
      ...(item.request.host === 'www.yuketang.cn' ? { cookie: 'sessionid=sess-fixture' }
        : item.request.host === 'www.xuetangx.com' ? { cookie: 'sessionid=xtx-sess-fixture' } : {}),
    },
  }));
}

export function get(host, path, body, { query = {}, headers = {}, status = 200 } = {}) {
  return strict([{ request: { method: 'GET', host, path, query }, response: { status, headers, body } }])[0];
}

export const red = readFileSync(new URL('../fixtures/exports/red.png', import.meta.url));
export const blue = readFileSync(new URL('../fixtures/exports/blue.png', import.meta.url));
export const clip = readFileSync(new URL('../fixtures/exports/clip.mp4', import.meta.url));
export const segment = readFileSync(new URL('../fixtures/exports/red.mpegts', import.meta.url));
export const blueSegment = readFileSync(new URL('../fixtures/exports/blue.mpegts', import.meta.url));
export const initSegment = readFileSync(new URL('../fixtures/exports/init.mp4', import.meta.url));
export const fragment = readFileSync(new URL('../fixtures/exports/fragment.m4s', import.meta.url));
// A valid MP4 followed by a legal free atom gives a deterministic >8 MiB checkpoint.
const padding = Buffer.alloc(9 * 1024 * 1024, 0x31);
padding.writeUInt32BE(padding.length, 0);
padding.write('free', 4);
export const largeClip = Buffer.concat([clip, padding]);
export const changedClip = Buffer.concat([clip, Buffer.from(padding).fill(0x53, 8)]);

export function asset(host, path, bytes, options = {}) {
  const item = get(host, path, '', { headers: {
    'content-type': options.mime ?? 'video/mp4',
    'content-length': String(bytes.length),
    ...options.headers,
  }, status: options.status ?? 200 });
  item.request.headers = { range: null, 'if-range': null, ...options.requestHeaders };
  item.response.base64 = bytes.toString('base64');
  if (options.respond) item.response.respond = options.respond;
  return item;
}

export function media(platform, path = platform === 'ykt' ? '/hd.m3u8' : '/hd.mp4', quality = 'hd') {
  const items = fixture(platform + '/media');
  const sources = platform === 'ykt' ? items[1].response.body.data.playurl.sources : items[1].response.body.data.sources;
  sources[quality === 'hd' ? 'quality20' : 'quality10'] = ['https://' + items[1].request.host + path];
  return strict(items);
}

export function slides(pages = [{ index: 2, cover: 'https://www.yuketang.cn/e2e/blue.png' }, { index: 0, cover: 'https://www.yuketang.cn/e2e/red.png' }]) {
  const items = fixture('ykt/history-slides').slice(1);
  items[2].response.body.data.slideList = pages;
  return strict(items);
}

export function outline(platform) {
  const items = fixture(platform === 'ykt' ? 'ykt/nested-outline' : 'xuetang/outline');
  if (platform === 'ykt') {
    const leaves = items[2].response.body.data.course_chapter[0].section_leaf_list;
    leaves.push({ id: 505, leafinfo_id: 605, name: '只读作业', leaf_type: 6, chapter_id: 11, order: 3 });
    leaves.push({ id: 510, leafinfo_id: 610, name: '已结束试卷', leaf_type: 5, chapter_id: 11, order: 4 });
  } else {
    items.shift(); // outline(key) already owns the course obtained by the courses command.
    items[0].response.body.data.course_chapter.leaf_list.push(
      { id: 31, leafinfo_id: 131, name: '学堂作业', leaf_type: 6, chapter_id: 150, order: 2 },
      { id: 30, leafinfo_id: 130, name: '学堂结果', leaf_type: 5, chapter_id: 150, order: 3 },
    );
  }
  return strict(items);
}

export const xtHomework = [
  get('www.xuetangx.com', '/api/v1/lms/learn/leaf_info/100/31/', { success: true, data: { leaf_type: 6, content_info: { leaf_type_id: 888 } } }, { query: { sign: 'SIGN-A' } }),
  get('www.xuetangx.com', '/api/v1/lms/exercise/get_exercise_list/888/900/', { success: true, data: {
    exercise_id: 888, name: '只读电路作业', problems: [{ problem_id: 11, content: { Type: 'FillBlank', Body: '<p>电阻 R = ? Ω</p>', Blanks: [{ Num: 1 }] }, user: { my_count: 0 } }],
  } }),
];

export const embedded = [
  get('www.yuketang.cn', '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', { success: true, data: { leaf_type: 0, sku_id: 901, content_info: { media: { ccid: 'CC1', exercise_id: 888 } } } }, { query: { classroom_id: '28930736' } }),
  get('www.yuketang.cn', '/mooc-api/v1/lms/exercise/leaf_video/problem/901/502/888/', { success: true, data: [{ problem_id: 11, content: { ProblemType: 1, Body: '<p>只读内嵌题</p>', Options: [{ key: 'A', value: '<p>甲</p>' }] }, user: { is_right: false } }] }, { query: { classroom_id: '28930736' } }),
];
