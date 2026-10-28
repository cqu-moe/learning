import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const fixture = name => JSON.parse(readFileSync(new URL('../../packages/sdk/tests/fixtures/' + name + '.json', import.meta.url), 'utf8')).interactions;
export const yt = 'www.yuketang.cn', xt = 'www.xuetangx.com', examHost = 'examination.xuetangx.com';
export function get(host, path, body, query = {}) {
  return { request: { method: 'GET', host, path, query, headers: { xtbz: host === yt ? 'ykt' : host === xt ? 'xt' : 'cloud' }, cookie: host === yt ? 'sessionid=sess-fixture' : host === xt ? 'sessionid=xtx-sess-fixture' : 'x_access_token=xtx-exam-sess' }, response: { body } };
}
export function post(host, path, body, accept, options = {}) {
  return { request: { method: 'POST', host, path, query: options.query ?? {}, headers: { xtbz: host === yt ? 'ykt' : host === xt ? 'xt' : 'cloud', 'content-type': 'application/json;charset=utf-8', ...options.headers }, cookie: host === yt ? 'sessionid=sess-fixture' : host === xt ? 'sessionid=xtx-sess-fixture' : 'x_access_token=xtx-exam-sess', ...(typeof body === 'function' ? { validate: body } : { body }) }, response: { body: options.reply ?? (host === examHost ? { errcode: 0 } : { success: true }) }, accept, loseResponse: options.loseResponse };
}

// External platform state starts unanswered. No SDK/session/job facts are seeded.
export function writeFixtures() {
  const state = { homework: {}, embedded: false, examStatus: 0, examAnswers: [], comments: [] };
  const problem = (id, text) => ({ problem_id: id, content: { ProblemType: 1, Body: text, Options: [{ key: 'A', value: '甲' }, { key: 'B', value: '乙' }] } });
  const problems = [problem(11, '精确答案'), problem(12, '无公开答案'), problem(13, '来源冲突'), problem(14, '仅建议')];
  const hwRead = (platform, changed = []) => platform === 'ykt'
    ? get(yt, '/mooc-api/v1/lms/exercise/get_exercise_list/888001/', () => ({ success: true, data: { problems: problems.map(p => ({
      ...p,
      content: { ...p.content, Body: changed.includes(p.problem_id) ? p.content.Body + '（平台已更新）' : p.content.Body },
      user: { my_count: state.homework[p.problem_id] === undefined ? 0 : 1, answer: state.homework[p.problem_id] ?? null },
    })) } }), { classroom_id: '28930736' })
    : get(xt, '/api/v1/lms/exercise/get_exercise_list/888/900/', () => ({ success: true, data: { exercise_id: 888, problems: [{ problem_id: 21, content: { Type: 'SingleChoice', Body: '学堂作业', Options: [{ key: 'A', value: '甲' }, { key: 'B', value: '乙' }] }, user: { my_count: state.homework.xt ? 1 : 0, answer: state.homework.xt ?? null } }] } }));
  const leaf = (platform, id, kind, assessmentId) => get(platform === 'ykt' ? yt : xt, `${platform === 'ykt' ? '/mooc-api' : '/api'}/v1/lms/learn/leaf_info/${platform === 'ykt' ? '28930736' : '100'}/${id}/`, { success: true, data: { leaf_type: kind, content_info: { leaf_type_id: assessmentId } } }, platform === 'ykt' ? { classroom_id: '28930736' } : { sign: 'SIGN-A' });
  const embeddedRead = () => [get(yt, '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', { success: true, data: { leaf_type: 0, sku_id: 901, content_info: { media: { exercise_id: 888 } } } }, { classroom_id: '28930736' }), get(yt, '/mooc-api/v1/lms/exercise/leaf_video/problem/901/502/888/', () => ({ success: true, data: [{ ...problem(11, '内嵌题'), user: { is_right: state.embedded } }] }), { classroom_id: '28930736' })];
  const cover = () => get(xt, '/api/v1/lms/exam/cover', () => ({ data: { data: { show_perm: 1, result: { status: state.examStatus }, user: { user_id: 77 } } } }), { exam_id: '3908258' });
  const sso = () => fixture('xuetang/exam-read').slice(2, 5);
  const examRead = () => [cover(), ...sso(), get(examHost, '/exam_room/show_paper', { errcode: 0, data: { problems: [{ problem_id: 1, Problem: { ProblemType: 'SingleChoice', Body: '考试选择', Options: [{ Key: 'A', Value: '甲' }, { Key: 'B', Value: '乙' }] } }, { problem_id: 9, Problem: { ProblemType: 'FillInBlank', Body: '未验证填空' } }] } }, { exam_id: '3908258' }), get(examHost, '/exam_room/problem_results', () => ({ errcode: 0, data: { results: state.examAnswers.map(p => ({ problem_id: p.problem_id, Answer: p.result[0] })) } }), { exam_id: '3908258' })];
  const topic = () => get(xt, '/api/v1/lms/forum/unit/discussion/', () => ({ id: 55, user_id: 77, content: { text: '合成讨论主题' }, commented: state.comments.length }), { product_sign: 'SIGN-A', leaf_id: '32', classroom_id: '100', topic_type: '0', channel: 'xt' });
  const comments = () => get(xt, '/api/v1/lms/forum/comment/list/55/', () => ({ data: { results: state.comments } }), { offset: '0', limit: '10', cid: '100', lid: '32' });
  return {
    state, problems, hwRead, leaf, embeddedRead, cover, sso, examRead, topic, comments,
    homeworkWrite(platform, loseResponse = false) {
      return platform === 'ykt' ? post(yt, '/mooc-api/v1/lms/exercise/problem_apply/', { classroom_id: '28930736', problem_id: '11', answer: ['B'] }, b => { state.homework[11] = b.answer; }, { loseResponse })
        : post(xt, '/api/v1/lms/exercise/problem_apply/', { leaf_id: 31, classroom_id: 100, exercise_id: 888, problem_id: 21, sign: 'SIGN-A', answers: {}, answer: ['B'] }, b => { state.homework.xt = b.answer; }, { headers: { 'x-csrftoken': 'xtx-csrf-fixture' }, loseResponse });
    },
    embeddedWrite() { return post(yt, '/mooc-api/v1/lms/exercise/leaf_video/problem/reply/11/', { exercise_id: 888, sku_id: 901, leaf_id: 502, answer: ['B'] }, () => { state.embedded = true; }, { headers: { 'x-csrftoken': 'ykt-csrf-fixture', 'x-requested-with': 'XMLHttpRequest' }, reply: { success: true, data: { is_right: true, answer: ['B'] } } }); },
    startWrite() { return post(examHost, '/exam_room/start_paper', { exam_id: 3908258 }, () => { state.examStatus = 1; }); },
    saveWrite() { return post(examHost, '/exam_room/answer_problem', b => {
      assert.deepEqual(Object.keys(b).sort(), ['exam_id', 'record', 'results']); assert.equal(b.exam_id, 3908258); assert.deepEqual(b.record, []);
      assert.equal(b.results.length, 1); assert.deepEqual(Object.keys(b.results[0]).sort(), ['problem_id', 'result', 'time']);
      assert.equal(b.results[0].problem_id, 1); assert.deepEqual(b.results[0].result, ['B']); assert.ok(Number.isSafeInteger(b.results[0].time) && b.results[0].time > 0);
    }, b => { state.examAnswers = JSON.parse(JSON.stringify(b.results)); }); },
    discussionWrite(loseResponse = false) { return post(xt, '/api/v1/lms/forum/comment/', { topic_id: '55', to_user: 77, content: { text: '仅合成平台讨论回复', upload_images: [] } }, b => { state.comments.push({ id: 100 + state.comments.length, user_id: 77, content: b.content }); }, { query: { classroom_id: '100', leaf_id: '32' }, loseResponse }); },
  };
}
