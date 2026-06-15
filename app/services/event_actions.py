class EventActions:
    
    def update_event(self, db, event, updates, google_service, graph_client, user):
        """
        ✅ PURPOSE:
        Update event BOTH:
        - locally (your database)
        - remotely (Google + Outlook)

        ✅ WHY THIS IS IMPORTANT:
        This is what makes your app a "controller" of calendars
        """

        # ===============================
        # ✅ STEP 1: UPDATE LOCAL DATABASE
        # ===============================
        if "title" in updates:
            event.title = updates["title"]

        if "start_time" in updates:
            event.start_time = updates["start_time"]

        if "end_time" in updates:
            event.end_time = updates["end_time"]

        db.commit()

        # ===============================
        # ✅ STEP 2: UPDATE GOOGLE
        # ===============================
        # Only if event came from Google
        if event.external_ids and "google" in event.external_ids:

            google_service.update_event(
                token=user.google_access_token,
                event_id=event.external_ids["google"],
                updates=updates
            )

        # ===============================
        # ✅ STEP 3: UPDATE MICROSOFT (SAFE + CANONICAL)
        # ===============================
        # --------------------------------------------------
        # PURPOSE:
        # Handle BOTH legacy ("outlook") and canonical ("microsoft")
        #
        # WHY:
        # Your system is migrating to "microsoft"
        # but older DB entries may still use "outlook"
        # --------------------------------------------------

        ms_id = None

        if event.external_ids:
            ms_id = (
                event.external_ids.get("microsoft")  # ✅ NEW STANDARD
                or event.external_ids.get("outlook")  # ✅ LEGACY FALLBACK
            )

        # ✅ ONLY RUN IF FOUND
        if ms_id:
            print("🧪 MICROSOFT UPDATE →", ms_id)  # ✅ DEBUG

            graph_client.update_event(
                token=user.ms_access_token,
                event_id=ms_id,
                updates=updates
            )

        return event


    def delete_event(self, db, event, google_service, graph_client, user):
        """
        ✅ PURPOSE:
        Delete an event across ALL systems

        ✅ WHAT HAPPENS:
        1. Delete from Google
        2. Delete from Outlook
        3. Delete from local DB
        """

        # =============================================================
        # ✅ STEP 1: DELETE FROM GOOGLE
        # =============================================================
        if event.external_ids and "google" in event.external_ids:

            google_service.delete_event(
                token=user.google_access_token,
                event_id=event.external_ids["google"]
            )

        # =============================================================
        # ✅ STEP 2: DELETE FROM MICROSOFT (SAFE + CANONICAL)
        # =============================================================
        ms_id = None

        if event.external_ids:
            ms_id = (
                event.external_ids.get("microsoft")
                or event.external_ids.get("outlook")
            )

        if ms_id:
            print("🧪 MICROSOFT DELETE →", ms_id)  # ✅ DEBUG

            graph_client.delete_event(
                token=user.ms_access_token,
                event_id=ms_id
            )

        # =============================================================
        # ✅ STEP 3: DELETE FROM DATABASE
        # =============================================================
        db.delete(event)
        db.commit()

        return True