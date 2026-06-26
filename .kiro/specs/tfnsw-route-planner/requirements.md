# Requirements Document

## Introduction

A route planning application that integrates with the Transport for NSW (TfNSW) API. The application allows users to search for transport locations, find available routes between two points, and compare routes based on speed and cost to make informed travel decisions.

The initial delivery target is a responsive web application accessible via desktop and mobile browsers. A native Android app is planned for a later stage. The web app should be designed with mobile-first responsive principles to facilitate future Android development.

## Glossary

- **Route_Planner**: The application system that provides route planning functionality using TfNSW data
- **TfNSW_API**: The Transport for NSW public API that provides transport data including stops, routes, and trips. The TfNSW_API does not return Opal fare data; fares are estimated by the Route_Planner from the Opal_Fares_Dataset
- **Location**: A transport stop, station, platform, or point of interest that can serve as a trip origin or destination
- **Route**: A complete journey plan from origin to destination, including transfers and intermediate stops
- **Fastest_Route**: The route option with the shortest total travel time from origin to destination
- **Economical_Route**: The route option with the lowest total fare cost from origin to destination
- **Travel_Time**: The total duration of a route from departure at origin to arrival at destination, including waiting and transfer times
- **Fare_Cost**: The total ESTIMATED monetary cost of a route, computed by the Route_Planner by summing the estimated adult Opal fare of each priced leg. Fare_Cost is an estimate derived from the Opal_Fares_Dataset (distance bands per transport mode), not a value returned by the TfNSW_API. Transfer discounts and daily/weekly fare caps are out of scope for this version.
- **Opal_Fares_Dataset**: The separate Opal fare reference data (distance bands and corresponding adult fare values per transport mode) used by the Route_Planner to estimate the fare of each leg from its travel distance and mode
- **Search_Results**: A list of matching locations returned by the TfNSW_API based on user input
- **Route_Comparison**: A side-by-side presentation of route options highlighting differences in travel time and fare cost

## Requirements

### Requirement 1: Location Search

**User Story:** As a commuter, I want to search for transport locations by name, so that I can select my trip origin and destination.

#### Acceptance Criteria

1. WHEN a user enters a search query of at least 3 characters in the origin or destination input field, THE Route_Planner SHALL query the TfNSW_API and return up to 10 matching locations within 3 seconds
2. WHEN the TfNSW_API returns matching locations, THE Route_Planner SHALL display the location name, type, and suburb for each result in a selectable list
3. WHEN a user selects a location from the Search_Results, THE Route_Planner SHALL store it as the value for the input field (origin or destination) in which the search was initiated
4. IF the TfNSW_API returns no matching locations, THEN THE Route_Planner SHALL display a message indicating no locations were found for the given query
5. IF the TfNSW_API is unreachable or returns an error, THEN THE Route_Planner SHALL display an error message indicating the service is temporarily unavailable and retain any previously entered text in the input field
6. IF a user enters fewer than 3 characters in a search field, THEN THE Route_Planner SHALL NOT query the TfNSW_API and SHALL clear any previously displayed Search_Results

### Requirement 2: Route Discovery

**User Story:** As a commuter, I want to find available routes between my selected origin and destination, so that I can plan my journey.

#### Acceptance Criteria

1. WHEN a user has selected both an origin and a destination, THE Route_Planner SHALL enable the route search function
2. WHEN a user initiates a route search, THE Route_Planner SHALL query the TfNSW_API for available trips and display up to 5 route results within 5 seconds, ordered by earliest departure time
3. WHEN routes are returned, THE Route_Planner SHALL display for each route: departure time, arrival time, total Travel_Time, number of transfers, and transport modes used
4. IF no routes are available between the selected origin and destination, THEN THE Route_Planner SHALL inform the user that no routes were found and suggest selecting a different origin, destination, or travel time
5. IF the origin and destination are the same location, THEN THE Route_Planner SHALL display a validation message and prevent route search
6. IF the TfNSW_API is unreachable or returns an error during route search, THEN THE Route_Planner SHALL display an error message indicating the service is temporarily unavailable and retain the user's selected origin and destination

### Requirement 3: Fastest Route Selection

**User Story:** As a time-conscious commuter, I want to identify and select the fastest route, so that I can minimise my travel time.

#### Acceptance Criteria

1. WHEN route results are displayed, THE Route_Planner SHALL visually distinguish the Fastest_Route from other routes based on total Travel_Time, and IF multiple routes share the same lowest Travel_Time, THEN THE Route_Planner SHALL select the route with the fewest transfers as the Fastest_Route
2. WHEN a user selects the fastest route option, THE Route_Planner SHALL display the full journey details from the already-retrieved route search results, including each leg, departure and arrival times, transport mode, and platform information where available
3. THE Route_Planner SHALL calculate Travel_Time as the duration from scheduled departure at origin to scheduled arrival at destination, including transfer waiting times
4. IF route detail retrieval fails after a user selects the fastest route, THEN THE Route_Planner SHALL display an error message indicating that journey details could not be loaded and allow the user to retry the selection

### Requirement 4: Economical Route Selection

**User Story:** As a budget-conscious commuter, I want to identify and select the most economical route, so that I can minimise my travel cost.

#### Acceptance Criteria

1. WHEN route results are displayed, THE Route_Planner SHALL identify and highlight the Economical_Route based on lowest total Fare_Cost. IF two or more routes share the same lowest Fare_Cost, THEN THE Route_Planner SHALL highlight the one with the shortest Travel_Time among them.
2. WHEN a user selects the economical route option, THE Route_Planner SHALL display the full journey details from the already-retrieved route search results, including: each leg with departure time, arrival time, and transport mode; the estimated fare for each individual priced leg; and the total estimated Fare_Cost for the journey.
3. THE Route_Planner SHALL calculate an estimated Fare_Cost for each priced leg of the journey from the leg's travel distance and transport mode using the Opal_Fares_Dataset (distance-band estimation), where transfer discounts and daily/weekly fare caps are out of scope for this version.
4. WHERE a fare is displayed, THE Route_Planner SHALL indicate that the displayed fare is an estimate.
5. WHERE a leg uses a walk or bicycle transport mode, THE Route_Planner SHALL treat that leg as unpriced and exclude it from Fare_Cost estimation.
6. IF a fare estimate cannot be produced for any priced leg of a route, THEN THE Route_Planner SHALL indicate that a fare estimate is not available and exclude that route from economical ranking.

### Requirement 5: Route Comparison

**User Story:** As a commuter, I want to compare the fastest and most economical routes side by side, so that I can make an informed decision balancing time and cost.

#### Acceptance Criteria

1. WHEN both a Fastest_Route and an Economical_Route have been identified, THE Route_Planner SHALL provide a Route_Comparison view displaying both routes side by side
2. WHILE the Route_Comparison view is displayed, THE Route_Planner SHALL show for each route: total Travel_Time in hours and minutes, total estimated Fare_Cost in AUD to two decimal places, number of transfers, and transport modes used
3. WHILE the Route_Comparison view is displayed, THE Route_Planner SHALL display the numerical difference in Travel_Time (in minutes) and the numerical difference in estimated Fare_Cost (in AUD) between the two routes, labelling which route is faster and which is cheaper
4. WHEN the Fastest_Route and the Economical_Route are the same route, THE Route_Planner SHALL display a single route and indicate that it is both the fastest and most economical option
5. WHEN a user selects a route from the Route_Comparison view, THE Route_Planner SHALL display the full journey details for the selected route including each leg, departure and arrival times, and transport mode
6. IF fare information is unavailable for the Fastest_Route, THEN THE Route_Planner SHALL display the Fastest_Route with a notice that fare data is unavailable and present only Travel_Time and transfer count for comparison
