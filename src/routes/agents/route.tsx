import {
  Outlet,
  redirect,
  createFileRoute,
  defaultStringifySearch,
} from '@tanstack/react-router';
import { AppSidebar } from '~/components/app-sidebar';
import { SiteHeader } from '~/components/site-header';
import { SidebarInset, SidebarProvider } from '~/components/ui/sidebar';
import { getEmailVerificationConfig, getSession } from '~/server/function/auth.server.func';
import { EmailVerificationBanner } from '~/components/email-verification-banner';

export const Route = createFileRoute('/agents')({
  // All children (/agents, /agents/settings, etc.) inherit this guard
  beforeLoad: async ({ location }) => {
    const shouldLog = import.meta.env.DEV;
    if (shouldLog) {
      console.log('[Route /agents] beforeLoad - starting', {
        pathname: location.pathname,
        search: location.search,
        hasSearch: !!location.search,
        searchType: typeof location.search,
      });
    }

    // Safely handle search params
    const searchParams = location.search || {};

    const [session, emailVerificationConfig] = await Promise.all([
      getSession(),
      getEmailVerificationConfig(),
    ]);

    if (shouldLog) {
      console.log('[Route /agents] getSession result:', {
        hasSession: !!session,
        hasUser: !!session?.user,
        userKeys: session?.user ? Object.keys(session.user) : [],
        user: session?.user,
      });
    }

    if (!session) {
      // Preserve deep link for redirect after sign-in
      let redirectPath: string | null = null;
      try {
        const searchString = defaultStringifySearch(searchParams);
        redirectPath = `${location.pathname}${searchString}`;
      } catch (error) {
        console.error('[Route /agents] Failed to build redirect path:', error);
      }

      if (shouldLog) {
        console.log('[Route /agents] Redirecting to sign-in:', { redirectPath });
      }

      throw redirect({
        to: '/auth/$pathname',
        params: { pathname: 'sign-in' },
        ...(redirectPath ? { search: { redirect: redirectPath } } : {}),
      });
    }

    // Ensure user object has all required fields
    const user = {
      id: session.user.id ?? '',
      email: session.user.email ?? '',
      name: session.user.name ?? null,
      image: session.user.image ?? null,
      emailVerified: session.user.emailVerified ?? false,
    };

    if (shouldLog) {
      console.log('[Route /agents] Returning user context:', { user });
    }

    return {
      user,
      emailVerificationEnabled: emailVerificationConfig.enabled,
    };
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { user, emailVerificationEnabled } = Route.useRouteContext();
  // open={false} 受控锁定主侧边栏为常驻图标条（IA redesign §3：主条不折叠，只 hover 提示）。
  return (
    <SidebarProvider open={false}>
      <AppSidebar variant="inset" user={user} />
      <SidebarInset>
        <SiteHeader />
        <div className="flex flex-1 flex-col min-h-0">
          {emailVerificationEnabled && !user.emailVerified ? (
            <EmailVerificationBanner email={user.email} />
          ) : null}
          <div className="@container/main flex flex-1 flex-col min-h-0 gap-2">
            <div className="flex flex-1 flex-col min-h-0 gap-4 md:gap-6 overflow-hidden">
              <Outlet />
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
