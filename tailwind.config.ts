/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        /* 语义色全部走 CSS 变量（见 src/styles/globals.css），
           这样深色/浅色切换不需要改任何组件的类名。 */
        border: "hsl(var(--border) / <alpha-value>)",
        "border-subtle": "hsl(var(--border-subtle) / <alpha-value>)",
        "border-strong": "hsl(var(--border-strong) / <alpha-value>)",
        /* 输入框边缘（无边框语言里唯一保留的实体感，只给可编辑控件） */
        field: "hsl(var(--field-border) / <alpha-value>)",
        /* 占位符专用：保证在 sunken 上有 4.5:1，不跟着 muted-foreground 再降 alpha */
        placeholder: "hsl(var(--placeholder) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
          /* 主色当「文字/链接」用时的变体：深色下填充色对卡片只有 3.6:1，
             不能为了文字可读去改填充色（会毁掉 btn-primary 上的白字对比）。 */
          text: "hsl(var(--primary-text) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        raised: "hsl(var(--surface-raised) / <alpha-value>)",
        sunken: "hsl(var(--surface-sunken) / <alpha-value>)",
        "surface-muted": "hsl(var(--surface-muted) / <alpha-value>)",
        success: {
          DEFAULT: "hsl(var(--success) / <alpha-value>)",
          foreground: "hsl(var(--success-foreground) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "hsl(var(--warning) / <alpha-value>)",
          foreground: "hsl(var(--warning-foreground) / <alpha-value>)",
        },
        info: {
          DEFAULT: "hsl(var(--info) / <alpha-value>)",
          foreground: "hsl(var(--info-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        /* 日志 / 终端井：深色恒定的「沉井」面 */
        code: {
          bg: "hsl(var(--code-bg) / <alpha-value>)",
          border: "hsl(var(--code-border) / <alpha-value>)",
          text: "hsl(var(--code-text) / <alpha-value>)",
          muted: "hsl(var(--code-muted) / <alpha-value>)",
          subtle: "hsl(var(--code-subtle) / <alpha-value>)",
          hover: "hsl(var(--code-hover) / <alpha-value>)",
        },
      },
      borderRadius: {
        sm: "4px",
        DEFAULT: "6px",
        md: "8px",
        lg: "10px",
        xl: "14px",
      },
      boxShadow: {
        panel: "var(--shadow-panel)",
        pop: "var(--shadow-pop)",
        inset: "inset 0 1px 0 0 hsl(var(--highlight) / 0.05)",
      },
      fontSize: {
        caption: ["11px", { lineHeight: "15px" }],
        ui: ["12px", { lineHeight: "17px" }],
        "ui-lg": ["13px", { lineHeight: "19px" }],
        title: ["15px", { lineHeight: "21px", letterSpacing: "-0.01em" }],
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Cascadia Mono", "Consolas", "monospace"],
      },
      keyframes: {
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "100% 0" },
          "100%": { backgroundPosition: "-100% 0" },
        },
      },
      animation: {
        "fade-in-up": "fade-in-up 140ms ease-out",
        shimmer: "shimmer 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
