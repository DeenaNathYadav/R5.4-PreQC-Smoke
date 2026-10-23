import type { ProductOverrides } from '../types';

/** Settings shared by every product that runs on the AdvantageGo Underwriting UI (axapreqc.advantagego.com). */
export const advantageGo: ProductOverrides = {
  login: { type: 'azure-ad' },
  homePath: '/ui/home/dashboard',
  loggedInIndicator: '#dropdownMenu2', // user menu in the top bar
  pages: [
    { name: 'Dashboard', path: '/ui/home/dashboard', title: 'Underwriting - Dashboard', expect: '#home-tab' },
    { name: 'WorkTray', path: '/ui/worktray/mains/dashboard?Type=Summary', title: 'Underwriting - WorkTray' },
    { name: 'Create New', path: '/ui/home/createNew', title: 'Underwriting - Create New', expect: 'text=What would you like to create?' },
    { name: 'New Submission', path: '/ui/home/newSubmission', title: 'Underwriting - New Submission', expect: 'text=Entering a New Submission' },
    { name: 'Notes', path: '/ui/notes/main', title: 'Underwriting - Notes' },
    { name: 'Documents', path: '/ui/home/documents', title: 'Underwriting - Document', expect: 'text=/Documents \\(\\d/' },
  ],
};
