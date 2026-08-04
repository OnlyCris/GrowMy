/**
 * Tailwind CSS v4 usa un plugin PostCSS dedicato.
 * Tutta la configurazione del tema vive in `src/app/globals.css` dentro il
 * blocco `@theme`: non esiste più un tailwind.config.js.
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
