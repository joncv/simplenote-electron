import React, { Component } from 'react';
import PropTypes from 'prop-types';
import { bindActionCreators } from 'redux';
import { connect } from 'react-redux';
import 'focus-visible/dist/focus-visible.js';
import appState from './flux/app-state';
import { loadTags } from './state/domain/tags';
import browserShell from './browser-shell';
import NoteInfo from './note-info';
import NavigationBar from './navigation-bar';
import AppLayout from './app-layout';
import DevBadge from './components/dev-badge';
import DialogRenderer from './dialog-renderer';
import { getIpcRenderer } from './utils/electron';
import exportZipArchive from './utils/export';
import { isElectron, isMac } from './utils/platform';
import { activityHooks, getUnsyncedNoteIds, nudgeUnsynced } from './utils/sync';
import { setLastSyncedTime } from './utils/sync/last-synced-time';
import analytics from './analytics';
import classNames from 'classnames';
import { debounce, get, has, isObject, overEvery, pick, values } from 'lodash';
import {
  createNote,
  closeNote,
  setUnsyncedNoteIds,
  toggleNavigation,
  toggleSimperiumConnectionStatus,
} from './state/ui/actions';

import * as settingsActions from './state/settings/actions';

import actions from './state/actions';
import * as S from './state';
import * as T from './types';

const ipc = getIpcRenderer();

export type OwnProps = {
  noteBucket: object;
};

export type DispatchProps = {
  createNote: () => any;
  closeNote: () => any;
  focusSearchField: () => any;
  selectNote: (note: T.NoteEntity) => any;
  showDialog: (type: T.DialogType) => any;
  trashNote: (previousIndex: number) => any;
};

export type Props = OwnProps & DispatchProps;

const mapStateToProps: S.MapState<S.State> = (state) => state;

const mapDispatchToProps: S.MapDispatch<
  DispatchProps,
  OwnProps
> = function mapDispatchToProps(dispatch, { noteBucket }) {
  const actionCreators = Object.assign({}, appState.actionCreators);

  const thenReloadNotes = (action) => (a) => {
    dispatch(action(a));
    dispatch(actionCreators.loadNotes({ noteBucket }));
  };

  const thenReloadTags = (action) => (a) => {
    dispatch(action(a));
    dispatch(loadTags());
  };

  return {
    actions: bindActionCreators(actionCreators, dispatch),
    ...bindActionCreators(
      pick(settingsActions, [
        'activateTheme',
        'decreaseFontSize',
        'increaseFontSize',
        'resetFontSize',
        'setLineLength',
        'setNoteDisplay',
        'setAccountName',
        'toggleAutoHideMenuBar',
        'toggleFocusMode',
        'toggleSpellCheck',
      ]),
      dispatch
    ),
    closeNote: () => dispatch(closeNote()),
    remoteNoteUpdate: (noteId, data) =>
      dispatch(actions.simperium.remoteNoteUpdate(noteId, data)),
    loadTags: () => dispatch(loadTags()),
    setSortType: thenReloadNotes(settingsActions.setSortType),
    toggleSortOrder: thenReloadNotes(settingsActions.toggleSortOrder),
    toggleSortTagsAlpha: thenReloadTags(settingsActions.toggleSortTagsAlpha),
    createNote: () => dispatch(createNote()),
    openTagList: () => dispatch(toggleNavigation()),
    selectNote: (note: T.NoteEntity) => dispatch(actions.ui.selectNote(note)),
    focusSearchField: () => dispatch(actions.ui.focusSearchField()),
    setSimperiumConnectionStatus: (connected) =>
      dispatch(toggleSimperiumConnectionStatus(connected)),
    setUnsyncedNoteIds: (noteIds) => dispatch(setUnsyncedNoteIds(noteIds)),
    showDialog: (dialog) => dispatch(actions.ui.showDialog(dialog)),
    trashNote: (previousIndex) => dispatch(actions.ui.trashNote(previousIndex)),
  };
};

export const App = connect(
  mapStateToProps,
  mapDispatchToProps
)(
  class extends Component<Props> {
    static displayName = 'App';

    static propTypes = {
      actions: PropTypes.object.isRequired,
      appState: PropTypes.object.isRequired,
      client: PropTypes.object.isRequired,
      isDevConfig: PropTypes.bool.isRequired,
      isSmallScreen: PropTypes.bool.isRequired,
      loadTags: PropTypes.func.isRequired,
      openTagList: PropTypes.func.isRequired,
      settings: PropTypes.object.isRequired,
      preferencesBucket: PropTypes.object.isRequired,
      systemTheme: PropTypes.string.isRequired,
      tagBucket: PropTypes.object.isRequired,
    };

    UNSAFE_componentWillMount() {
      if (isElectron) {
        this.initializeElectron();
      }

      this.onAuthChanged();
    }

    componentDidMount() {
      ipc.on('appCommand', this.onAppCommand);
      ipc.send('setAutoHideMenuBar', this.props.settings.autoHideMenuBar);
      ipc.send('settingsUpdate', this.props.settings);

      this.props.noteBucket
        .on('index', this.onNotesIndex)
        .on('update', this.onNoteUpdate)
        .on('update', debounce(this.onNotesIndex, 200, { maxWait: 1000 })) // refresh notes list
        .on('remove', this.onNoteRemoved)
        .beforeNetworkChange((noteId) =>
          this.props.actions.onNoteBeforeRemoteUpdate({
            noteId,
          })
        );

      this.props.preferencesBucket.on('update', this.onLoadPreferences);

      this.props.tagBucket
        .on('index', this.props.loadTags)
        .on('update', debounce(this.props.loadTags, 200))
        .on('remove', this.props.loadTags);

      this.props.client
        .on('authorized', this.onAuthChanged)
        .on('unauthorized', this.onAuthChanged)
        .on('message', setLastSyncedTime)
        .on('message', this.syncActivityHooks)
        .on('send', this.syncActivityHooks)
        .on('connect', () => this.props.setSimperiumConnectionStatus(true))
        .on('disconnect', () => this.props.setSimperiumConnectionStatus(false));

      this.onLoadPreferences(() =>
        // Make sure that tracking starts only after preferences are loaded
        analytics.tracks.recordEvent('application_opened')
      );

      this.toggleShortcuts(true);

      __TEST__ && window.testEvents.push('booted');
    }

    componentWillUnmount() {
      this.toggleShortcuts(false);

      ipc.removeListener('appCommand', this.onAppCommand);
    }

    componentDidUpdate(prevProps) {
      const { settings } = this.props;

      if (settings !== prevProps.settings) {
        ipc.send('settingsUpdate', settings);
      }
    }

    handleShortcut = (event: KeyboardEvent) => {
      const {
        settings: { keyboardShortcuts },
      } = this.props;
      if (!keyboardShortcuts) {
        return;
      }
      const { code, ctrlKey, metaKey, shiftKey } = event;

      // Is either cmd or ctrl pressed? (But not both)
      const cmdOrCtrl = (ctrlKey || metaKey) && ctrlKey !== metaKey;

      // open tag list
      if (
        cmdOrCtrl &&
        shiftKey &&
        'KeyU' === code &&
        !this.props.showNavigation
      ) {
        this.props.openTagList();

        event.stopPropagation();
        event.preventDefault();
        return false;
      }

      if (
        (cmdOrCtrl && shiftKey && 'KeyS' === code) ||
        (isElectron && cmdOrCtrl && !shiftKey && 'KeyF' === code)
      ) {
        this.props.focusSearchField();

        event.stopPropagation();
        event.preventDefault();
        return false;
      }

      if (cmdOrCtrl && shiftKey && 'KeyF' === code) {
        this.props.toggleFocusMode();

        event.stopPropagation();
        event.preventDefault();
        return false;
      }

      if (cmdOrCtrl && shiftKey && 'KeyI' === code) {
        this.props.actions.newNote({
          noteBucket: this.props.noteBucket,
        });
        analytics.tracks.recordEvent('list_note_created');

        event.stopPropagation();
        event.preventDefault();
        return false;
      }

      // prevent default browser behavior for search
      // will bubble up from note-detail
      if (cmdOrCtrl && 'KeyG' === code) {
        event.stopPropagation();
        event.preventDefault();
      }

      return true;
    };

    onAppCommand = (event, command) => {
      if ('exportZipArchive' === get(command, 'action')) {
        exportZipArchive();
      }

      if ('printNote' === command.action) {
        return window.print();
      }

      if ('focusSearchField' === command.action) {
        return this.props.focusSearchField();
      }

      if ('showDialog' === command.action) {
        return this.props.showDialog(command.dialog);
      }

      if ('trashNote' === command.action && this.props.ui.note) {
        return this.props.actions.trashNote({
          noteBucket: this.props.noteBucket,
          note: this.props.ui.note,
          previousIndex: this.props.appState.notes.findIndex(
            ({ id }) => this.props.ui.note.id === id
          ),
        });
      }

      const canRun = overEvery(
        isObject,
        (o) => o.action !== null,
        (o) => has(this.props.actions, o.action) || has(this.props, o.action)
      );

      if (canRun(command)) {
        // newNote expects a bucket to be passed in, but the action method itself wouldn't do that
        if (command.action === 'newNote') {
          this.props.actions.newNote({
            noteBucket: this.props.noteBucket,
          });
          analytics.tracks.recordEvent('list_note_created');
        } else if (has(this.props, command.action)) {
          const { action, ...args } = command;

          this.props[action](...values(args));
        } else {
          this.props.actions[command.action](command);
        }
      }
    };

    onAuthChanged = () => {
      const {
        appState: { accountName },
      } = this.props;

      analytics.initialize(accountName);
      this.onLoadPreferences();

      // 'Kick' the app to ensure content is loaded after signing in
      this.onNotesIndex();
      this.props.loadTags();
    };

    onNotesIndex = () => {
      const { noteBucket, setUnsyncedNoteIds } = this.props;
      const { loadNotes } = this.props.actions;

      loadNotes({ noteBucket });
      setUnsyncedNoteIds(getUnsyncedNoteIds(noteBucket));

      __TEST__ && window.testEvents.push('notesLoaded');
    };

    onNoteRemoved = () => this.onNotesIndex();

    onNoteUpdate = (
      noteId: T.EntityId,
      data,
      remoteUpdateInfo: { patch?: object } = {}
    ) => {
      const {
        noteBucket,
        selectNote,
        ui: { note },
      } = this.props;

      this.props.remoteNoteUpdate(noteId, data);

      if (note && noteId === note.id) {
        noteBucket.get(noteId, (e: unknown, storedNote: T.NoteEntity) => {
          if (e) {
            return;
          }
          const updatedNote = remoteUpdateInfo.patch
            ? { ...storedNote, hasRemoteUpdate: true }
            : storedNote;
          selectNote(updatedNote);
        });
      }
    };

    onLoadPreferences = (callback) =>
      this.props.actions.loadPreferences({
        callback,
        preferencesBucket: this.props.preferencesBucket,
      });

    getTheme = () => {
      const {
        settings: { theme },
        systemTheme,
      } = this.props;
      return 'system' === theme ? systemTheme : theme;
    };

    initializeElectron = () => {
      const { remote } = __non_webpack_require__('electron'); // eslint-disable-line no-undef

      this.setState({
        electron: {
          currentWindow: remote.getCurrentWindow(),
          Menu: remote.Menu,
        },
      });
    };

    onUpdateContent = (note, content, sync = false) => {
      if (!note) {
        return;
      }

      const updatedNote = {
        ...note,
        data: {
          ...note.data,
          content,
          modificationDate: Math.floor(Date.now() / 1000),
        },
      };

      this.props.selectNote(updatedNote);

      const { noteBucket } = this.props;
      noteBucket.update(note.id, updatedNote.data, {}, { sync });
      if (sync) {
        this.syncNote(note.id);
      }
    };

    syncNote = (noteId) => {
      this.props.noteBucket.touch(noteId);
    };

    syncActivityHooks = (data) => {
      activityHooks(data, {
        onIdle: () => {
          const {
            appState: { notes },
            client,
            noteBucket,
            setUnsyncedNoteIds,
          } = this.props;

          nudgeUnsynced({ client, noteBucket, notes });
          setUnsyncedNoteIds(getUnsyncedNoteIds(noteBucket));
        },
      });
    };

    toggleShortcuts = (doEnable) => {
      if (doEnable) {
        window.addEventListener('keydown', this.handleShortcut, true);
      } else {
        window.removeEventListener('keydown', this.handleShortcut, true);
      }
    };

    loadPreferences = () => {
      this.props.actions.loadPreferences({
        preferencesBucket: this.props.preferencesBucket,
      });
    };

    render() {
      const {
        appState: state,
        isDevConfig,
        noteBucket,
        preferencesBucket,
        settings,
        tagBucket,
        isSmallScreen,
        ui: { showNavigation, showNoteInfo },
      } = this.props;

      const themeClass = `theme-${this.getTheme()}`;

      const appClasses = classNames('app', themeClass, {
        'is-line-length-full': settings.lineLength === 'full',
        'touch-enabled': 'ontouchstart' in document.body,
      });

      const mainClasses = classNames('simplenote-app', {
        'note-info-open': showNoteInfo,
        'navigation-open': showNavigation,
        'is-electron': isElectron,
        'is-macos': isMac,
      });

      return (
        <div className={appClasses}>
          {isDevConfig && <DevBadge />}
          <div className={mainClasses}>
            {showNavigation && <NavigationBar />}
            <AppLayout
              isFocusMode={settings.focusModeEnabled}
              isNavigationOpen={showNavigation}
              isNoteInfoOpen={showNoteInfo}
              isSmallScreen={isSmallScreen}
              noteBucket={noteBucket}
              onUpdateContent={this.onUpdateContent}
              syncNote={this.syncNote}
            />
            {showNoteInfo && <NoteInfo noteBucket={noteBucket} />}
          </div>
          <DialogRenderer
            appProps={this.props}
            buckets={{ noteBucket, preferencesBucket, tagBucket }}
            themeClass={themeClass}
          />
        </div>
      );
    }
  }
);

export default browserShell(App);
