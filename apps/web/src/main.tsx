import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BookOpen,
  GraduationCap,
  LayoutDashboard,
  UsersRound,
} from "lucide-react";
import {
  createBrowserRouter,
  RouterProvider,
  NavLink,
  Outlet,
  Link,
  useRouteError,
  useRevalidator,
  useNavigation,
  useLocation,
  useRouteLoaderData,
} from "react-router";
import {
  ThemeProvider,
  Toaster,
  ThemeMenu,
  AppShell,
  ContentContainer,
  PageHeader,
  PageState,
  Button,
} from "@cqu-moe/ui";
import { DashboardSchema, OutlineResultSchema, JobDetailSchema } from "../shared/contracts.ts";
import type { JobDetail as JobDetailData } from "../shared/contracts.ts";
import { useDashboard } from "./data.ts";
import { api, ApiError, errorMessage } from "./api.ts";
import { activeStatuses } from "./components.tsx";
import { Overview } from "./pages/overview.tsx";
import { Courses, CourseDetail } from "./pages/courses.tsx";
import { Jobs, JobDetail } from "./pages/jobs.tsx";
import { Accounts } from "./pages/accounts.tsx";
import "@cqu-moe/theme/styles.css";
import "@cqu-moe/ui/styles.css";
import "./styles.css";

function Layout() {
  const dashboard = useDashboard();
  const { revalidate, state } = useRevalidator();
  const navigation = useNavigation();
  const { pathname } = useLocation();
  const detail = useRouteLoaderData<JobDetailData>("job-detail");
  const running = detail ? activeStatuses.includes(detail.job.status) :
    (pathname === "/" || pathname.startsWith("/jobs")) &&
    dashboard.jobs.some((job) => activeStatuses.includes(job.status));
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && state === "idle")
        void revalidate();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [running, revalidate, state]);
  return (
    <AppShell
      brand={
        <Link className="brand" to="/">
          <GraduationCap size={24} aria-hidden="true" />
          <span>Learning</span>
        </Link>
      }
      utilities={
        <>
          <span className="local-label">本地工作台</span>
          <ThemeMenu />
        </>
      }
      navigation={
        <>
          <span className="nav-caption">学习空间</span>
          <NavLink to="/" end>
            <LayoutDashboard aria-hidden="true" />
            概览
          </NavLink>
          <NavLink to="/courses">
            <BookOpen aria-hidden="true" />
            我的课程
          </NavLink>
          <NavLink to="/jobs">
            <Activity aria-hidden="true" />
            任务中心
          </NavLink>
          <span className="nav-caption nav-caption-secondary">管理</span>
          <NavLink to="/accounts">
            <UsersRound aria-hidden="true" />
            平台账号
          </NavLink>
          <div className="nav-note">
            <span>你的学习，由你掌握。</span>
            <small>数据保存在这台设备上</small>
          </div>
        </>
      }
    >
      <ContentContainer width="standard">
        <div className="navigation-status" aria-live="polite">
          {navigation.state === "loading" ? "正在加载页面…" : ""}
        </div>
        <Outlet />
      </ContentContainer>
    </AppShell>
  );
}

function RouteError() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : 500;
  const { revalidate, state } = useRevalidator();
  return (
    <ContentContainer>
      <PageHeader title="暂时无法显示内容" />
      <PageState
        state={
          status === 404 ? "not-found" : status === 403 ? "forbidden" : "error"
        }
        title={
          status === 404
            ? "没有找到这项内容"
            : status === 401
              ? "需要重新登录"
              : "请求未完成"
        }
        description={errorMessage(error)}
        action={
          <div className="actions">
            <Button
              onClick={() => void revalidate()}
              disabled={state !== "idle"}
            >
              重新加载
            </Button>
            <Button asChild variant="outline">
              <Link to={status === 401 ? "/accounts" : "/"}>
                {status === 401 ? "管理账号" : "返回概览"}
              </Link>
            </Button>
          </div>
        }
      />
    </ContentContainer>
  );
}

const router = createBrowserRouter([
  {
    id: "workspace",
    loader: ({ request }) =>
      api("/dashboard", DashboardSchema, { signal: request.signal }),
    element: <Layout />,
    errorElement: <RouteError />,
    hydrateFallbackElement: (
      <ContentContainer>
        <PageHeader title="Learning" />
        <PageState
          state="loading"
          title="正在打开学习空间"
          description="读取本机课程与任务。"
        />
      </ContentContainer>
    ),
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { index: true, element: <Overview /> },
          { path: "courses", element: <Courses /> },
          {
            path: "courses/:key",
            loader: ({ params, request }) =>
              api(
                `/courses/${encodeURIComponent(params.key ?? "")}/outline`,
                OutlineResultSchema,
                { signal: request.signal },
              ),
            element: <CourseDetail />,
          },
          { path: "jobs", element: <Jobs /> },
          {
            id: "job-detail",
            path: "jobs/:id",
            loader: ({ params, request }) =>
              api(`/jobs/${encodeURIComponent(params.id ?? "")}/details`, JobDetailSchema, {
                signal: request.signal,
              }),
            element: <JobDetail />,
          },
          { path: "accounts", element: <Accounts /> },
          {
            path: "*",
            element: (
              <>
                <PageHeader title="页面不存在" />
                <PageState
                  state="not-found"
                  title="这个页面不在学习空间中"
                  description="检查地址，或回到概览继续。"
                  action={
                    <Button asChild variant="outline">
                      <Link to="/">返回概览</Link>
                    </Button>
                  }
                />
              </>
            ),
          },
        ],
      },
    ],
  },
]);
createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <RouterProvider router={router} />
    <Toaster />
  </ThemeProvider>,
);
