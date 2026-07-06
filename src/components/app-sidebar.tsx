import { Link } from '@tanstack/react-router';
import type * as React from 'react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIntlayer } from 'react-intlayer';
import { ArrowUpCircle } from 'lucide-react';
import { NavMain } from '~/components/nav-main';
import { NavUser } from '~/components/nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '~/components/ui/sidebar';
import FileTextIcon from 'virtual:icons/ri/file-text-line';
import HomeSmileIcon from 'virtual:icons/ri/home-smile-line';
import SparklingIcon from 'virtual:icons/ri/sparkling-line';
import AppsIcon from 'virtual:icons/ri/apps-2-line';
import ScanIcon from 'virtual:icons/ri/scan-2-line';
import ShieldIcon from 'virtual:icons/ri/shield-line';
import PaletteIcon from 'virtual:icons/ri/palette-line';
import { FEATURE_CONFIG } from '~/config/features';
import { isAdminUser } from '~/server/function/skills.server';
import { getUpdateStatus } from '~/server/function/updater.server';
import { ServerUpdateDialog } from '~/components/admin/server-update-dialog';

type SidebarUser = {
  name?: string | null;
  email: string;
  image?: string | null;
  systemRole?: string | null;
};

export function AppSidebar({ user, ...props }: React.ComponentProps<typeof Sidebar> & { user: SidebarUser }) {
  const content = useIntlayer('app');
  const sv = useIntlayer('serverUpdate');

  // Query admin status using Server Function directly
  const { data: adminCheck } = useQuery({
    queryKey: ['admin-check'],
    queryFn: async () => await isAdminUser(),
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    refetchOnWindowFocus: false,
  });
  const isAdmin = adminCheck?.isAdmin ?? false;

  // Online auto-update: "auto-check" (default ON) controls the background re-poll cadence.
  // Persisted per-browser; the worker always checks server-side regardless.
  const [autoCheck, setAutoCheck] = useState(true);
  useEffect(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem('kin.autoCheckUpdates') : null;
    if (v !== null) setAutoCheck(v === 'true');
  }, []);
  const handleAutoCheck = (value: boolean) => {
    setAutoCheck(value);
    if (typeof window !== 'undefined') window.localStorage.setItem('kin.autoCheckUpdates', String(value));
  };

  const [updateOpen, setUpdateOpen] = useState(false);
  const { data: updateStatus } = useQuery({
    queryKey: ['update-status'],
    queryFn: async () => await getUpdateStatus(),
    enabled: isAdmin,
    staleTime: 60 * 1000,
    refetchInterval: autoCheck ? 10 * 60 * 1000 : false,
    refetchOnWindowFocus: false,
  });

  // Three independent modules (IA redesign 2026-06, docs/project/prd/2026-06-navigation-ia-redesign-prd.md).
  // Projects moved into the agent workbench (副侧边栏 ProjectsRail); dashboards/charts moved to admin.
  const navSections = [
    {
      items: [
        {
          title: content.nav.claudeChat,
          url: '/agents/c',
          icon: SparklingIcon,
          enabled: FEATURE_CONFIG.claudeChat,
        },
        {
          title: content.nav.capabilityCenter,
          url: '/agents/capabilities',
          icon: AppsIcon,
          enabled: FEATURE_CONFIG.skills || FEATURE_CONFIG.mcpStore,
        },
        {
          title: content.nav.documents,
          url: '/agents/documents',
          icon: FileTextIcon,
          enabled: FEATURE_CONFIG.documents,
        },
        {
          title: content.nav.ocr,
          url: '/agents/ocr',
          icon: ScanIcon,
          enabled: FEATURE_CONFIG.ocr,
        },
        {
          title: content.nav.canvas,
          url: '/agents/canvas',
          icon: PaletteIcon,
          enabled: FEATURE_CONFIG.canvas,
        },
      ],
    },
  ].map((section) => ({
    ...section,
    items: section.items.filter((item) => item.enabled),
  })).filter((section) => section.items.length > 0);

  // Admin section (shown only to users with systemRole='admin')
  const adminSection = {
    title: content.nav.admin,
    items: [
      {
        title: content.nav.adminPanel,
        url: '/admin',
        icon: ShieldIcon,
        enabled: true,
      },
    ],
    hasDivider: false,
  };

  const resolvedUser = {
    name: user.name ?? user.email,
    email: user.email,
    avatar: user.image ?? null,
  };

  // Combine sections: add admin section if user is admin
  const allSections = isAdmin
    ? [...navSections, adminSection]
    : navSections;

  return (
    <>
      <Sidebar collapsible="icon" {...props}>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:!p-1.5">
                <Link to="/agents/c">
                  <HomeSmileIcon className="!size-5" />
                  <span className="font-semibold text-base">{content.common.appName}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <NavMain sections={allSections} />
          {isAdmin && updateStatus?.updateAvailable && (
            <SidebarMenu className="px-2">
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setUpdateOpen(true)}>
                  <ArrowUpCircle className="size-4 text-primary" />
                  <span>{sv.sidebar.updateAvailable}</span>
                  <span className="ml-auto inline-block size-2 rounded-full bg-primary" aria-hidden="true" />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          )}
        </SidebarContent>
        <SidebarFooter>
          <NavUser user={resolvedUser} />
        </SidebarFooter>
      </Sidebar>
      {isAdmin && updateStatus && (
        <ServerUpdateDialog
          open={updateOpen}
          onOpenChange={setUpdateOpen}
          status={{
            currentSha: updateStatus.currentSha,
            latestSha: updateStatus.latestSha,
            updateAvailable: updateStatus.updateAvailable,
            image: updateStatus.image,
          }}
          autoCheck={autoCheck}
          onAutoCheckChange={handleAutoCheck}
        />
      )}
    </>
  );
}
