/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: [
    "./src/renderer/index.html",
    "./src/renderer/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        calm: {
          cream: "#f7f5f0",
          parchment: "#f0ede6",
          stone: "#e8e4db",
          sage: "#7a9e7e",
          lavender: "#a8b4c4",
          sand: "#d4b896",
          charcoal: "#3d4043",
        },
        neon: {
          blue: "#3b82f6",
          purple: "#8b5cf6",
          pink: "#ec4899",
          teal: "#14b8a6",
          green: "#10b981",
          amber: "#f59e0b",
          red: "#ef4444",
        },
        bg: {
          deep: "#050505",
          primary: "#0a0a0f",
          secondary: "#12121a",
          tertiary: "#1a1a25",
          glass: "rgba(255, 255, 255, 0.03)",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      boxShadow: {
        "soft-sm": "0 2px 4px rgba(0,0,0,0.02), 0 1px 2px rgba(0,0,0,0.03)",
        "soft-md": "0 4px 12px rgba(0,0,0,0.04), 0 2px 4px rgba(0,0,0,0.03)",
        "soft-lg":
          "0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.05)",
        "soft-xl": "0 20px 50px -12px rgba(0,0,0,0.15)",
        "glow-blue": "0 0 15px rgba(59, 130, 246, 0.12)",
        "glow-purple": "0 0 15px rgba(139, 92, 246, 0.12)",
        "glow-pink": "0 0 15px rgba(236, 72, 153, 0.12)",
        "glow-teal": "0 0 15px rgba(20, 184, 166, 0.12)",
        "glow-primary": "0 8px 32px rgba(59, 130, 246, 0.3)",
        "glow-secondary": "0 8px 32px rgba(139, 92, 246, 0.25)",
      },
      borderRadius: {
        neu: "24px",
        "neu-sm": "16px",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      transitionTimingFunction: {
        neu: "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "SF Mono", "Fira Code", "monospace"],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        float: {
          "0%, 100%": { transform: "translate(0, 0) scale(1)" },
          "25%": { transform: "translate(20px, -20px) scale(1.02)" },
          "50%": { transform: "translate(-15px, 15px) scale(0.98)" },
          "75%": { transform: "translate(15px, 8px) scale(1.01)" },
        },
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.95) translateY(10px)" },
          to: { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        "slide-fade-in": {
          from: { opacity: "0", transform: "translateX(12px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        float: "float 25s ease-in-out infinite",
        pulse: "pulse 2.5s ease-in-out infinite",
        "fade-in": "fade-in 0.2s ease-out forwards",
        "scale-in": "scale-in 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "slide-fade-in": "slide-fade-in 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards",
      },
    },
  },
  plugins: [],
}
