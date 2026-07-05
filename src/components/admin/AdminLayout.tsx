/**
 * Admin Layout Component
 *
 * Layout wrapper for admin pages with sidebar navigation
 */

import * as React from 'react';
import { Outlet, useNavigate, Link, useLocation } from '@tanstack/react-router';
import RiLogoutBoxLine from '~icons/ri/logout-box-line';
import RiArrowLeftLine from '~icons/ri/arrow-left-line';
import { usePostHog } from '@posthog/react';
import { adminNavGroups, type AdminSection } from './admin-nav';
import { authClient } from '~/lib/auth-client';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { cn } from '~/lib/utils';

export function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const posthog = usePostHog();

  // Determine active section from current route path
  const getActiveSectionFromPath = (): AdminSection => {
    const pathname = location.pathname;

    if (pathname === '/admin' || pathname === '/admin/') return 'overview';
    if (pathname.startsWith('/admin/users')) return 'users';
    if (pathname.startsWith('/admin/usage')) return 'usage';
    if (pathname.startsWith('/admin/models')) return 'models';
    if (pathname.startsWith('/admin/variables')) return 'variables';
    if (pathname.startsWith('/admin/a2composer')) return 'a2composer';
    if (pathname.startsWith('/admin/skills')) return 'skills';
    if (pathname.startsWith('/admin/updates')) return 'updates';
    if (pathname.startsWith('/admin/audit')) return 'audit';
    if (pathname.startsWith('/admin/health')) return 'health';
    if (pathname.startsWith('/admin/performance')) return 'performance';

    return 'overview';
  };

  const currentActiveSection = getActiveSectionFromPath();

  const handleLogout = async () => {
    try {
      posthog?.reset();
      await authClient.signOut();
      navigate({ to: '/auth/$pathname', params: { pathname: 'sign-in' } });
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="flex w-72 flex-col border-r bg-card">
        {/* Logo */}
        <div className="flex h-16 items-center border-b px-6">
          <div>
            <h1 className="text-base font-semibold leading-none">Admin</h1>
            <p className="mt-1 text-xs text-muted-foreground">Operations & governance</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <div className="space-y-5">
            {adminNavGroups.map((group) => (
              <div key={group.label}>
                <div className="mb-2 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
                <ul className="space-y-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = item.section === currentActiveSection;
                    const className = cn(
                      'flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      item.disabled
                        ? 'cursor-not-allowed text-muted-foreground/70'
                        : isActive
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-foreground hover:bg-muted'
                    );

                    return (
                      <li key={item.section}>
                        {item.path && !item.disabled ? (
                          <Link to={item.path} className={className}>
                            <Icon className="h-4 w-4 shrink-0" />
                            <span className="truncate">{item.label}</span>
                          </Link>
                        ) : (
                          <div className={className} aria-disabled="true">
                            <Icon className="h-4 w-4 shrink-0" />
                            <span className="truncate">{item.label}</span>
                            <Badge variant="outline" className="ml-auto text-[10px]">
                              Soon
                            </Badge>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        {/* Footer */}
        <div className="space-y-2 border-t p-4">
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => navigate({ to: '/agents/c' })}
          >
            <RiArrowLeftLine className="h-4 w-4 mr-2" />
            Back to App
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30"
            onClick={handleLogout}
          >
            <RiLogoutBoxLine className="h-4 w-4 mr-2" />
            Logout
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
