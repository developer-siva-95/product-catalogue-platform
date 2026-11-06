import { Link } from 'react-router';
import EmptyState from '../components/EmptyState.jsx';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';

export function NotFoundPage() {
  useDocumentTitle('Page not found');
  return (
    <div className="container page">
      <EmptyState
        icon="🧭"
        title="Page not found"
        description="The page you were looking for does not exist or has moved."
        action={
          <Link className="btn btn--primary" to="/">
            Back to the storefront
          </Link>
        }
      />
    </div>
  );
}

export default NotFoundPage;
