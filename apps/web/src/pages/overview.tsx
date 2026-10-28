import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  Plus,
  RefreshCw,
  TriangleAlert,
  UsersRound,
} from "lucide-react";
import { Button, PageHeader, PageState } from "@cqu-moe/ui";
import { Link, useRevalidator } from "react-router";
import { useDashboard } from "../data.ts";
import {
  activeStatuses,
  attentionStatuses,
  CourseCard,
  JobRow,
  formatTime,
  platforms,
} from "../components.tsx";

export function Overview() {
  const data = useDashboard();
  const { revalidate, state } = useRevalidator();
  const active = data.jobs.filter((job) => activeStatuses.includes(job.status));
  const attention = data.jobs.filter((job) =>
    attentionStatuses.includes(job.status),
  );
  const recent = [...data.jobs]
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, 4);
  const metrics = [
    {
      label: "我的课程",
      value: data.courses.length,
      note: "本机已缓存的课程",
      Icon: BookOpen,
      to: "/courses",
    },
    {
      label: "进行中的任务",
      value: active.length,
      note: "等待与运行中的任务",
      Icon: Activity,
      to: "/jobs?filter=active",
    },
    {
      label: "需要处理",
      value: attention.length,
      note: attention.length ? "查看详情后继续处理" : "暂时没有待处理事项",
      Icon: TriangleAlert,
      to: "/jobs?filter=attention",
    },
    {
      label: "平台账号",
      value: data.profiles.length,
      note: "已配置的本地账号",
      Icon: UsersRound,
      to: "/accounts",
    },
  ];
  return (
    <>
      <div className="eyebrow">
        {new Intl.DateTimeFormat("zh-CN", {
          month: "long",
          day: "numeric",
          weekday: "long",
        }).format(new Date())}
      </div>
      <PageHeader
        title="学习概览"
        description="把课程、任务和进度，放在一起。"
        actions={
          <Button asChild>
            <Link to={data.profiles.length ? "/courses" : "/accounts"}>
              {data.profiles.length ? (
                <BookOpen aria-hidden="true" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              {data.profiles.length ? "浏览课程" : "添加平台账号"}
            </Link>
          </Button>
        }
      />
      <div className="metric-grid">
        {metrics.map(({ label, value, note, Icon, to }) => (
          <section className="metric-card" key={label}>
            <div>
              <span>{label}</span>
              <Icon size={16} aria-hidden="true" />
            </div>
            <Link
              to={to}
              className="metric-number"
              aria-label={`${label} ${value}`}
            >
              {value}
            </Link>
            <p>{note}</p>
          </section>
        ))}
      </div>
      {!data.profiles.length && (
        <section className="welcome-panel">
          <div>
            <span className="eyebrow">从一个账号开始</span>
            <h2>欢迎来到你的学习空间</h2>
            <p>
              连接雨课堂、学堂在线或智慧树，即可集中查看课程和任务。已有的本机账号会自动出现在这里。
            </p>
          </div>
          <ol className="onboarding-steps">
            <li>
              <span>1</span>
              <div>
                <strong>添加平台账号</strong>
                <p>给账号起一个好认的名字</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>用手机扫码登录</strong>
                <p>在平台官方页面完成验证</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>把课程带到这里</strong>
                <p>在「我的课程」中刷新列表</p>
              </div>
            </li>
          </ol>
        </section>
      )}
      <div className="overview-columns">
        <section>
          <div className="section-heading">
            <div>
              <h2>我的课程</h2>
              <p>从熟悉的课程继续</p>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/courses">
                查看全部
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
          {data.courses.length ? (
            <div className="course-grid course-grid-overview">
              {data.courses.slice(0, 4).map((course) => (
                <CourseCard
                  key={course.ref.key}
                  course={course}
                  profile={data.profiles.find(
                    (p) => p.scope.profileId === course.ref.scope.profileId,
                  )}
                />
              ))}
            </div>
          ) : (
            <div className="surface">
              <PageState
                state="empty"
                title="课程会在这里集合"
                description={
                  data.profiles.length
                    ? "选择已登录的账号，刷新一次课程列表。"
                    : "添加并登录平台账号后，即可读取课程。"
                }
                action={
                  <Button asChild variant="outline">
                    <Link to={data.profiles.length ? "/courses" : "/accounts"}>
                      {data.profiles.length ? "获取课程" : "管理账号"}
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  </Button>
                }
              />
            </div>
          )}
        </section>
        <aside>
          <div className="section-heading">
            <div>
              <h2>现在关注</h2>
              <p>下一步，一目了然</p>
            </div>
          </div>
          <div className="surface attention-panel">
            <div className="attention-summary">
              {attention.length ? (
                <TriangleAlert size={24} aria-hidden="true" />
              ) : (
                <CheckCircle2 size={24} aria-hidden="true" />
              )}
              <h3>
                {attention.length
                  ? `${attention.length} 项任务需要你处理`
                  : "一切井然有序"}
              </h3>
              <p>
                {attention.length
                  ? "有任务暂停在问题或不确定结果处，查看详情后再继续。"
                  : "有需要确认或恢复的任务时，会在这里提醒你。"}
              </p>
              {attention.length > 0 && (
                <Button asChild variant="outline">
                  <Link to="/jobs?filter=attention">
                    查看待处理任务
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
              )}
            </div>
            <div className="account-summary">
              <h3>已连接的学习平台</h3>
              {data.profiles.length ? (
                Object.entries(platforms)
                  .filter(([platform]) =>
                    data.profiles.some((p) => p.scope.platform === platform),
                  )
                  .map(([platform, label]) => (
                    <div key={platform}>
                      <span>{label}</span>
                      <span>
                        {
                          data.profiles.filter(
                            (p) => p.scope.platform === platform,
                          ).length
                        }{" "}
                        个账号
                      </span>
                    </div>
                  ))
              ) : (
                <p className="muted">还没有添加平台账号</p>
              )}
              <Link to="/accounts" className="text-link">
                管理平台账号
                <ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </aside>
      </div>
      <section>
        <div className="section-heading">
          <div>
            <h2>最近的任务</h2>
            <p>查看进展，也保留每一步结果</p>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/jobs">
              任务中心
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <div className="surface">
          {recent.length ? (
            recent.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                profile={data.profiles.find(
                  (p) => p.scope.profileId === job.scope.profileId,
                )}
              />
            ))
          ) : (
            <div className="quiet-empty">
              <Activity size={20} aria-hidden="true" />
              <div>
                <h3>还没有任务记录</h3>
                <p>本机已有的学习和导出任务会同步显示在这里。</p>
              </div>
            </div>
          )}
        </div>
      </section>
      <footer className="page-footer">
        <span>本机数据 · 更新于 {formatTime(data.updatedAtMs)}</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={state !== "idle"}
          onClick={() => void revalidate()}
        >
          <RefreshCw aria-hidden="true" />
          {state === "idle" ? "刷新状态" : "正在刷新…"}
        </Button>
      </footer>
    </>
  );
}
