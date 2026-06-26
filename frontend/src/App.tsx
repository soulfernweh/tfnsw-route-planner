// Top-level app shell for the TfNSW Route Planner SPA.
//
// This establishes the mobile-first responsive layout and the regions where
// the search and results views mount in later tasks:
//   - SearchView region   -> LocationSearchField + RouteSearchController (11.2, 11.4)
//   - ResultsView region   -> RouteList + RouteComparisonView + JourneyDetailView (11.4, 11.6, 11.8)
//
// For task 11.1 these regions render placeholders only.

import './styles/app.css';

/** Placeholder for the search region (origin/destination inputs + controls). */
function SearchViewPlaceholder(): JSX.Element {
  return (
    <section className="app-region app-region--search" aria-label="Search">
      <h2 className="app-region__heading">Plan a trip</h2>
      <p className="app-placeholder">
        Origin and destination search will appear here.
      </p>
    </section>
  );
}

/** Placeholder for the results region (route list, comparison, detail). */
function ResultsViewPlaceholder(): JSX.Element {
  return (
    <section className="app-region app-region--results" aria-label="Results">
      <h2 className="app-region__heading">Routes</h2>
      <p className="app-placeholder">
        Route results and comparison will appear here once you search.
      </p>
    </section>
  );
}

/** The application shell: header, responsive layout, and mount regions. */
export function App(): JSX.Element {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__inner">
          <h1 className="app-header__title">TfNSW Route Planner</h1>
          <p className="app-header__subtitle">
            Find, compare, and choose the fastest or most economical trip.
          </p>
        </div>
      </header>

      <main className="app-main">
        <div className="app-layout">
          <SearchViewPlaceholder />
          <ResultsViewPlaceholder />
        </div>
      </main>

      <footer className="app-footer">
        Powered by the Transport for NSW Open Data Trip Planner.
      </footer>
    </div>
  );
}
