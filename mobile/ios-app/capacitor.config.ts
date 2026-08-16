import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "com.sherryjo.calendar",
    appName: "SherryJo Calendar",
    webDir: "dist",
    server: {
        url: "https://sherryjo-cal-app.realty-cal.workers.dev/login",
        cleartext: false,
        allowNavigation: ["sherryjo-cal-app.realty-cal.workers.dev"],
    },
    ios: {
        contentInset: "always",
        backgroundColor: "#f6f8fc",
        preferredContentMode: "mobile",
        scrollEnabled: true,
    },
    plugins: {
        SplashScreen: {
            launchShowDuration: 1200,
            launchAutoHide: true,
            backgroundColor: "#f6f8fc",
            showSpinner: false,
        },
        StatusBar: {
            style: "DARK",
            backgroundColor: "#f6f8fc",
            overlaysWebView: false,
        },
    },
};

export default config;