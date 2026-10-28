import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  Check,
  CirclePause,
  CirclePlay,
  Clock3,
  TriangleAlert,
} from "lucide-react";
import {
  Alert,
  AlertTitle,
  AlertDescription,
  Button,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@cqu-moe/ui";
import { Link } from "react-router";
import type { Course, Job, JobStatus, Platform } from "@learning/sdk/public";
import type { Profile } from "../shared/contracts.ts";

export const platforms: Record<Platform, string> = {
  ykt: "雨课堂",
  xuetang: "学堂在线",
  zhs: "智慧树",
};
export const jobKinds: Record<Job["kind"], string> = {
  study: "学习任务",
  export: "资源导出",
  homework: "作业处理",
  live: "课堂任务",
};
export const statuses: Record<JobStatus, string> = {
  queued: "等待开始",
  running: "进行中",
  waiting: "等待继续",
  paused: "已暂停",
  "needs-input": "需要处理",
  uncertain: "结果待核对",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "未完成",
  canceled: "已取消",
};
export const activeStatuses: JobStatus[] = ["queued", "running", "waiting"];
export const attentionStatuses: JobStatus[] = [
  "needs-input",
  "uncertain",
  "failed",
  "partial",
];

export function Status({ status }: { status: JobStatus }) {
  const Icon =
    status === "succeeded"
      ? Check
      : attentionStatuses.includes(status)
        ? TriangleAlert
        : status === "paused"
          ? CirclePause
          : activeStatuses.includes(status)
            ? CirclePlay
            : Clock3;
  const tone =
    status === "succeeded"
      ? "success"
      : attentionStatuses.includes(status)
        ? "warning"
        : "neutral";
  return (
    <span className={`status status-${tone}`}>
      <Icon size={16} aria-hidden="true" />
      {statuses[status]}
    </span>
  );
}

export function Failure({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>操作未完成</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {retry && (
          <Button variant="outline" size="sm" onClick={retry}>
            重试
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function ProfileSelect({
  profiles,
  value,
  onChange,
  id,
}: {
  profiles: Profile[];
  value: string;
  onChange: (value: string) => void;
  id: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="选择账号" />
      </SelectTrigger>
      <SelectContent>
        {profiles.map((profile) => (
          <SelectItem
            key={profile.scope.profileId}
            value={profile.scope.profileId}
          >
            {profile.name} · {platforms[profile.scope.platform]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CourseCard({
  course,
  profile,
}: {
  course: Course;
  profile?: Profile | undefined;
}) {
  return (
    <article className="course-card">
      <div className="course-meta">
        <span>
          <BookOpen size={16} aria-hidden="true" />
          {platforms[course.ref.scope.platform]}
        </span>
        <span>{course.term || "学期未提供"}</span>
      </div>
      <h3>
        <Link to={`/courses/${encodeURIComponent(course.ref.key)}`}>
          {course.title}
        </Link>
      </h3>
      <p className="course-teachers">
        {course.teachers.length ? course.teachers.join("、") : "教师信息未提供"}
      </p>
      <div className="course-footer">
        <span>{profile?.name ?? "本地账号"}</span>
        <Button asChild variant="ghost" size="sm">
          <Link to={`/courses/${encodeURIComponent(course.ref.key)}`}>
            查看课程
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
      {course.locked && <p className="muted small">课程当前受平台限制</p>}
    </article>
  );
}

export function JobProgress({ job }: { job: Job }) {
  const percent =
    job.total && job.total > 0
      ? Math.min(100, Math.round((job.completed / job.total) * 100))
      : null;
  return (
    <div className="job-progress">
      <div>
        <span>
          {job.completed} / {job.total ?? "—"} 项
        </span>
        <span>{percent === null ? "总数待确认" : `${percent}%`}</span>
      </div>
      {percent !== null && (
        <progress
          aria-label={`${jobKinds[job.kind]}进度`}
          value={job.completed}
          max={job.total ?? 1}
        />
      )}
    </div>
  );
}

export function JobRow({
  job,
  profile,
}: {
  job: Job;
  profile?: Profile | undefined;
}) {
  return (
    <article className="job-row">
      <div className="job-info">
        <Link to={`/jobs/${encodeURIComponent(job.id)}`}>
          {jobKinds[job.kind]}
        </Link>
        <span>
          {profile?.name ?? platforms[job.scope.platform]} ·{" "}
          {formatTime(job.updatedAtMs)}
        </span>
      </div>
      <Status status={job.status} />
      <JobProgress job={job} />
      <Button asChild variant="ghost" size="sm">
        <Link
          to={`/jobs/${encodeURIComponent(job.id)}`}
          aria-label={`查看${jobKinds[job.kind]}详情`}
        >
          详情
          <ArrowUpRight aria-hidden="true" />
        </Link>
      </Button>
    </article>
  );
}

export function formatTime(time: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(time);
}
