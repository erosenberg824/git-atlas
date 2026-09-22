# Requirements Document

## Introduction

The full-text search feature in git-atlas is presented through the SearchPanel component (`ui/src/features/search/SearchPanel.tsx`). Today the panel triggers a search only when the user presses the Enter key inside the search input; the magnifying-glass icon rendered beside the input is purely decorative and cannot be clicked. This feature converts that decorative icon into an interactive, accessible button that runs the search, matching the behavior of pressing Enter, while preserving the existing keyboard trigger and loading-spinner behavior. The change is confined to the SearchPanel component and its front-end presentation; no server, API, or other search bar (FindRefBox, BranchControl) is affected.

## Glossary

- **SearchPanel**: The React component at `ui/src/features/search/SearchPanel.tsx` that renders the full-text search input, the search trigger control, the loading indicator, and the results list.
- **Search_Button**: The clickable button that replaces the previously decorative magnifying-glass icon inside the SearchPanel input row and, when activated, runs the current search.
- **Search_Query**: The text currently held in the SearchPanel input field.
- **Empty_Query**: A Search_Query that is either zero-length or contains only whitespace characters.
- **In_Flight_Search**: The state during which a previously initiated search has not yet completed (represented by the SearchPanel `loading` state being true).
- **Loading_Spinner**: The animated indicator shown in the SearchPanel input row while an In_Flight_Search is active.
- **Accessible_Label**: A programmatically associated text label that assistive technologies announce for the Search_Button.

## Requirements

### Requirement 1: Clickable Search Button

**User Story:** As a user searching files at a commit, I want to click a search button in the panel, so that I can run a search without relying on the keyboard.

#### Acceptance Criteria

1. THE SearchPanel SHALL render the magnifying-glass control as an interactive Search_Button in the input row.
2. WHEN the user activates the Search_Button, THE SearchPanel SHALL run the search using the current Search_Query.
3. WHEN the user activates the Search_Button with a non-empty Search_Query, THE SearchPanel SHALL produce the same search behavior as pressing the Enter key in the input field.

### Requirement 2: Button Enable and Disable States

**User Story:** As a user, I want the search button disabled when there is nothing to search or a search is already running, so that I do not trigger empty or duplicate searches.

#### Acceptance Criteria

1. WHILE the Search_Query is an Empty_Query, THE SearchPanel SHALL keep the Search_Button in a disabled state.
2. WHILE an In_Flight_Search is active, THE SearchPanel SHALL keep the Search_Button in a disabled state.
3. WHILE the Search_Query is non-empty and no In_Flight_Search is active, THE SearchPanel SHALL keep the Search_Button in an enabled state.
4. WHILE the Search_Button is in a disabled state, THE SearchPanel SHALL NOT run a search in response to activation attempts on the Search_Button.

### Requirement 3: Preserve Enter-Key Search

**User Story:** As a keyboard user, I want the existing Enter-key search to keep working, so that adding the button does not remove behavior I rely on.

#### Acceptance Criteria

1. WHEN the user presses the Enter key while the input field is focused, THE SearchPanel SHALL run the search using the current Search_Query.
2. WHEN the user presses the Enter key with an Empty_Query, THE SearchPanel SHALL NOT initiate a search.

### Requirement 4: Loading Indicator During Search

**User Story:** As a user, I want to see when a search is running, so that I understand the panel is working.

#### Acceptance Criteria

1. WHILE an In_Flight_Search is active, THE SearchPanel SHALL display the Loading_Spinner in the input row.
2. WHEN an In_Flight_Search completes, THE SearchPanel SHALL remove the Loading_Spinner from the input row.

### Requirement 5: Accessible Button Labeling and Focus

**User Story:** As a user relying on assistive technology, I want the search button to be labeled and reachable, so that I can operate it without visual cues.

#### Acceptance Criteria

1. THE SearchPanel SHALL provide an Accessible_Label for the Search_Button.
2. WHILE the Search_Button is in an enabled state, THE SearchPanel SHALL expose the Search_Button as keyboard-focusable.
3. WHILE the Search_Button is in a disabled state, THE SearchPanel SHALL expose the disabled state to assistive technologies.

### Requirement 6: Adherence to Project Conventions

**User Story:** As a maintainer, I want the change to stay within existing project conventions, so that it integrates cleanly with the codebase.

#### Acceptance Criteria

1. THE SearchPanel SHALL implement the Search_Button as a front-end-only change within `ui/src/features/search/SearchPanel.tsx`.
2. THE SearchPanel SHALL style the Search_Button using the existing Tailwind v4 dark-theme presentation used by the panel.
3. THE SearchPanel SHALL define the Search_Button in TypeScript strict mode without use of the `any` type.
