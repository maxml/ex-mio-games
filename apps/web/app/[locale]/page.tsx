import { HomePage } from '@/layers/views/home';

// `app/**` stays Next-routes-only (ADR-0001 §3.1, Variant A): this route is a thin
// shell that renders the `HomePage` view from the FSD `views` layer. `HomePage`
// is an async Server Component, so it is delegated directly as the route's page
// component (rendering an async component as a JSX child is not valid under the
// React 18 types). The active locale is set by the parent `[locale]` layout, so
// `HomePage` can resolve translations via `getTranslations`.
export default HomePage;
