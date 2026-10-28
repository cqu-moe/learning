import { useEffect, useRef, useState } from "react";
import { Link, useLoaderData, useParams, useRevalidator } from "react-router";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  FileText,
  Film,
  LockKeyhole,
  MessageCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  ActionButton,
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Input,
  Label,
  PageHeader,
  PageState,
} from "@cqu-moe/ui";
import type { OutlineNode, ResourceKind } from "@learning/sdk/public";
import { CoursePageSchema } from "../../shared/contracts.ts";
import type { OutlineResult } from "../../shared/contracts.ts";
import { useDashboard } from "../data.ts";
import { api, errorMessage } from "../api.ts";
import {
  CourseCard,
  Failure,
  platforms,
  ProfileSelect,
} from "../components.tsx";
import { TaskComposer } from "./task-composer.tsx";

export function Courses() {
  const data = useDashboard();
  const { revalidate } = useRevalidator();
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("all");
  const [profileId, setProfileId] = useState(
    data.profiles[0]?.scope.profileId ?? "",
  );
  const [cursor, setCursor] = useState<string | null>(null);
  const [complete, setComplete] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const search = query.trim().toLocaleLowerCase();
  const courses = data.courses.filter(
    (course) =>
      (platform === "all" || course.ref.scope.platform === platform) &&
      [course.title, ...course.teachers, course.term]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(search),
  );
  function chooseProfile(id: string) {
    pending.current?.abort();
    setProfileId(id);
    setCursor(null);
    setComplete(null);
    setWarnings([]);
    setError(null);
    setSyncState("idle");
  }
  async function refresh(next = false) {
    if (!profileId || syncState === "loading") return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setSyncState("loading");
    setError(null);
    try {
      const page = await api(
        `/profiles/${encodeURIComponent(profileId)}/courses${next && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        CoursePageSchema,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setCursor(page.nextCursor);
      setComplete(page.completeness);
      setWarnings(page.warnings.map((w) => w.message));
      await revalidate();
      if (!controller.signal.aborted) setSyncState("success");
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(errorMessage(failure));
        setSyncState("error");
      }
    }
  }
  return (
    <>
      <PageHeader
        title="我的课程"
        description="在不同平台之间，找到你正在学习的内容。"
        actions={
          <Button asChild variant="outline">
            <Link to="/accounts">管理账号</Link>
          </Button>
        }
      />
      {data.profiles.length > 0 && (
        <section className="surface sync-panel" aria-label="同步平台课程">
          <div className="sync-account">
            <Label htmlFor="sync-profile">获取平台课程</Label>
            <ProfileSelect
              profiles={data.profiles}
              value={profileId}
              onChange={chooseProfile}
              id="sync-profile"
            />
          </div>
          <ActionButton
            state={syncState}
            labels={{
              idle: "刷新课程",
              loading: "正在读取…",
              success: "重新刷新",
              error: "重试刷新",
            }}
            onClick={() => void refresh()}
          />
          <p>刷新所选账号的课程。已缓存的课程可随时浏览。</p>
        </section>
      )}
      {error && <Failure message={error} />}
      {(warnings.length > 0 || complete === "unknown") && (
        <Alert>
          <AlertTitle>课程列表可能不完整</AlertTitle>
          <AlertDescription>
            {warnings.length
              ? warnings.join("；")
              : "平台尚未确认列表完整性，当前显示已读取的课程。"}
          </AlertDescription>
        </Alert>
      )}
      <div className="course-toolbar">
        <div className="search-field">
          <Label htmlFor="course-search" className="visually-hidden">
            搜索课程或教师
          </Label>
          <Search size={16} aria-hidden="true" />
          <Input
            type="search"
            id="course-search"
            placeholder="搜索课程、教师…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="filter-group" role="group" aria-label="按平台筛选">
          <Button
            variant={platform === "all" ? "secondary" : "ghost"}
            aria-pressed={platform === "all"}
            onClick={() => setPlatform("all")}
          >
            全部平台
          </Button>
          {Object.entries(platforms).map(([key, label]) => (
            <Button
              key={key}
              variant={platform === key ? "secondary" : "ghost"}
              aria-pressed={platform === key}
              onClick={() => setPlatform(key)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <div className="list-caption" aria-live="polite">
        <span>{courses.length} 门课程</span>
        <span>本机已缓存</span>
      </div>
      {courses.length ? (
        <div className="course-grid">
          {courses.map((course) => (
            <CourseCard
              key={course.ref.key}
              course={course}
              profile={data.profiles.find(
                (profile) =>
                  profile.scope.profileId === course.ref.scope.profileId,
              )}
            />
          ))}
        </div>
      ) : (
        <div className="surface">
          <PageState
            state="empty"
            title={data.courses.length ? "没有找到匹配的课程" : "还没有课程"}
            description={
              data.courses.length
                ? "试试其他关键词，或查看全部平台。"
                : data.profiles.length
                  ? "登录平台账号后，点击「刷新课程」获取课程列表。"
                  : "先添加一个平台账号，登录后即可获取课程。"
            }
            action={
              data.courses.length ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuery("");
                    setPlatform("all");
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                <Button asChild variant="outline">
                  <Link to="/accounts">
                    {data.profiles.length ? "登录平台账号" : "添加平台账号"}
                  </Link>
                </Button>
              )
            }
          />
        </div>
      )}
      {cursor && complete === "more" && (
        <div className="load-more">
          <Button
            variant="outline"
            disabled={syncState === "loading"}
            onClick={() => void refresh(true)}
          >
            <RefreshCw aria-hidden="true" />
            {syncState === "loading" ? "正在读取…" : "加载更多课程"}
          </Button>
        </div>
      )}
    </>
  );
}

const kinds: Record<ResourceKind, string> = {
  video: "视频",
  document: "文档",
  homework: "作业",
  exam: "考试",
  discussion: "讨论",
  unknown: "内容",
};
const kindIcons = {
  video: Film,
  document: FileText,
  homework: FileText,
  exam: FileText,
  discussion: MessageCircle,
  unknown: BookOpen,
};

function OutlineSection({ nodes }: { nodes: OutlineNode[] }) {
  return (
    <div className="outline-list">
      {nodes.map((node) => (
        <details className="outline-section" key={node.id} open>
          <summary>
            <ChevronDown size={16} aria-hidden="true" />
            <span>{node.title || "课程章节"}</span>
            <span className="muted small">{node.resources.length} 项内容</span>
          </summary>
          {node.resources.map((resource) => {
            const Icon = kindIcons[resource.kind];
            return (
              <div className="resource-row" key={resource.ref.key}>
                <Icon size={16} aria-hidden="true" />
                <span>{resource.title || "未命名内容"}</span>
                <span className="muted small">
                  {kinds[resource.kind]}
                  {resource.durationSeconds !== null
                    ? ` · ${Math.ceil(resource.durationSeconds / 60)} 分钟`
                    : ""}
                </span>
                {resource.locked && (
                  <LockKeyhole size={16} aria-label="平台暂未开放" />
                )}
              </div>
            );
          })}
          {node.children.length > 0 && <OutlineSection nodes={node.children} />}
        </details>
      ))}
    </div>
  );
}

export function CourseDetail() {
  const { key } = useParams();
  const data = useDashboard();
  const course = data.courses.find((item) => item.ref.key === key);
  const result = useLoaderData<OutlineResult>();
  const { revalidate, state } = useRevalidator();
  return (
    <>
      <Link to="/courses" className="back-link">
        <ArrowLeft size={16} aria-hidden="true" />
        我的课程
      </Link>
      <PageHeader
        title={course?.title ?? "课程目录"}
        description={
          course
            ? [
                platforms[course.ref.scope.platform],
                course.term,
                course.teachers.join("、"),
              ]
                .filter(Boolean)
                .join(" · ")
            : "查看课程章节和内容。"
        }
        actions={
          <div className="actions">
            <TaskComposer
              courseKey={result.value.course.key}
              courseTitle={course?.title ?? result.value.course.key}
              platform={
                course?.ref.scope.platform ?? result.value.course.scope.platform
              }
              roots={result.value.roots}
            />
            <Button
              variant="outline"
              disabled={state !== "idle"}
              onClick={() => void revalidate()}
            >
              <RefreshCw aria-hidden="true" />
              {state === "idle" ? "刷新目录" : "正在读取…"}
            </Button>
          </div>
        }
      />
      {(result.warnings.length > 0 ||
        result.value.completeness === "unknown") && (
        <Alert>
          <AlertTitle>部分内容尚未确认</AlertTitle>
          <AlertDescription>
            {result.warnings.map((w) => w.message).join("；") ||
              "平台没有返回完整的课程目录。"}
          </AlertDescription>
        </Alert>
      )}
      <section>
        <div className="section-heading">
          <div>
            <h2>课程目录</h2>
            <p>展开章节，查看视频、文档与作业信息</p>
          </div>
        </div>
        <div className="surface">
          {result.value.roots.length ? (
            <OutlineSection nodes={result.value.roots} />
          ) : (
            <PageState
              state="empty"
              title="这门课程暂时没有内容"
              description="平台可能尚未发布章节，稍后刷新查看。"
            />
          )}
        </div>
      </section>
    </>
  );
}
