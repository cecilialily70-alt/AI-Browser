import { AppDialogProvider } from "../components/AppDialogProvider";
import { AppLayout } from "../components/AppLayout";
import { GlobalBannerProvider } from "../components/GlobalBannerProvider";
import { InterventionCenterPanel } from "../components/InterventionCenterPanel";
import { InterventionCenterProvider } from "../components/InterventionCenterProvider";
import { ThemeProvider } from "../lib/theme";

export default function App() {
  return (
    <ThemeProvider>
      <AppDialogProvider>
        <GlobalBannerProvider>
          <InterventionCenterProvider>
            <AppLayout />
            <InterventionCenterPanel />
          </InterventionCenterProvider>
        </GlobalBannerProvider>
      </AppDialogProvider>
    </ThemeProvider>
  );
}
