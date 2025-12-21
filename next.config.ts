import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
    reactStrictMode: false
};
export default nextConfig;
/*
const isProd = process.env.NODE_ENV === 'production';
module.exports = async (phase, { defaultConfig }) => {
  // En mode développement, on utilise TAURI_DEV_HOST pour se servir des assets si besoin.
  const internalHost = process.env.TAURI_DEV_HOST || 'localhost';
  const nextConfig = {
    // Assurez-vous que Next.js utilise SSG au lieu de SSR
    // https://nextjs.org/docs/pages/building-your-application/deploying/static-exports
    output: 'export',
    // Note: Cette fonctionnalité expérimentale est requise pour utiliser NextJS Image en mode SSG.
    // Voir https://nextjs.org/docs/messages/export-image-api pour des solutions différentes.
    images: {
      unoptimized: true,
    },
    // Configurez assetPrefix sinon le server ne résoudra pas correctement vos assets.
    assetPrefix: isProd ? null : `http://${internalHost}:3000`,
    reactStrictMode: false
  };
  return nextConfig;
};*/
