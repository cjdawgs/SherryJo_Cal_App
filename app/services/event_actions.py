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
        # ✅ STEP 3: UPDATE OUTLOOK
        # ===============================
        if event.external_ids and "outlook" in event.external_ids:

            graph_client.update_event(
                token=user.ms_access_token,
                event_id=event.external_ids["outlook"],
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

        # ===============================
        # ✅ STEP 1: DELETE FROM GOOGLE
        # ===============================
        if event.external_ids and "google" in event.external_ids:

            google_service.delete_event(
                token=user.google_access_token,
                event_id=event.external_ids["google"]
            )

        # ===============================
        # ✅ STEP 2: DELETE FROM OUTLOOK
        # ===============================
        if event.external_ids and "outlook" in event.external_ids:

            graph_client.delete_event(
                token=user.ms_access_token,
                event_id=event.external_ids["outlook"]
            )

        # ===============================
        # ✅ STEP 3: DELETE FROM DATABASE
        # ===============================
        db.delete(event)
        db.commit()

        return True