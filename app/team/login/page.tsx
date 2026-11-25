import TeamLoginForm from '@/components/team/TeamLoginForm';
import loginStyles from '@/components/team/login.module.css';
import { BRAND_ATTRIBUTION } from '@/lib/brand';

export default function TeamLoginPage() {
  const projectId = process.env.CREATIVE_STUDIO_SERVER_RELEASE_ID === 'local-preview' && process.env.CREATIVE_STUDIO_PREVIEW_FILM_PROJECT;
  return (
    <div className={loginStyles.screen}>
      <div className={loginStyles.backdrop} aria-hidden="true" />
      <div className={loginStyles.shade} aria-hidden="true" />
      <div className={loginStyles.body}>
        <TeamLoginForm destination={projectId ? '/one-click-film/' + encodeURIComponent(projectId) : '/'} />
        {/* 登录页底部一行归属文字（用户已确认）。 */}
        <p className={loginStyles.attribution}>{BRAND_ATTRIBUTION}</p>
      </div>
    </div>
  );
}
