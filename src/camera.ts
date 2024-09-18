import { MQTTFrigateEvent } from "./types"


function shouldTriggerObjectDetection(event:MQTTFrigateEvent):boolean {
  const eventInfo = {
    camera: event.after.camera,
    msg: 'Event ignored',
    reason: '',
    label: event.after.label,
    type: event.type,
    id: event.before?.id || event.after?.id
  }
  if(this.snapshotRequired && !event.after.has_snapshot) {
    eventInfo.reason = 'no_snapshot'
    this.logger?.info(eventInfo)
    return false
  }
  if(event.after.false_positive) {
    eventInfo.reason = 'false_positive'
    this.logger?.info(eventInfo)
    return false
  }
  if(event.before.stationary && event.after.stationary) {
    eventInfo.reason = 'stationary'
    this.logger?.info(eventInfo)
    return false
  }
  if(event.type !== 'new' && event.type !== 'update') {
    eventInfo.reason = 'neither_new_nor_update'
    this.logger?.info(eventInfo)
    return false
  }
  if(!event.before.label && !event.after.label) {
    eventInfo.reason = 'no_label'
    this.logger?.info(eventInfo)
    return false
  }

  return true
}

async function setEventActive(trackedObject:string, eventId:string) {
  if(!this.activeEvents.has(trackedObject)) {
    this.activeEvents.set(trackedObject, new Set<string>())
  }
  const events = this.activeEvents.get(trackedObject)
  if(!events?.has(eventId)) {
    events?.add(eventId)
    this._continuousCheckIfEventStillOngoing(trackedObject, eventId)
  }
  if(trackedObject === 'person') {
    await this.setCapabilityValue('person_detected', true)
  }
}

async function setEventEnded(trackedObject:string, eventId:string) {
  if(!this.activeEvents.has(trackedObject)) {
    return
  }
  const events = this.activeEvents.get(trackedObject)
  events?.delete(eventId)
  if(events?.size === 0) {
    this.activeEvents.delete(trackedObject)
    if(trackedObject === 'person') {
      await this.setCapabilityValue('person_detected', false)
    }
  }
}

function isEventActive(trackedObject:string, eventId:string) {
  return this.activeEvents.get(trackedObject)?.has(eventId)
}

async function clearAllActiveEvents() {
  this.activeEvents.clear()
  await this.setCapabilityValue('person_detected', false)
}

async function continuousCheckIfEventStillOngoing(trackedObject:string, eventId:string) {
  setTimeout(async () => {
    if(isEventActive(trackedObject, eventId)) {
      const ongoing = await frigateAPI.isEventOngoing({frigateURL:this.frigateURL!, eventId, logger: this.logger!})
      if(ongoing) {
        await continuousCheckIfEventStillOngoing(trackedObject, eventId)
      } else {
        await setEventEnded(trackedObject, eventId)
      }
    }
  }, 10000)
}

async function mqttHandleEvent(event:MQTTFrigateEvent) {

  const eventId = event.after.id
  const trackedObject = event.after.label || event.before.label

  if(!trackedObject) {
    return
  }

  if(shouldTriggerObjectDetection(event) && (!isEventActive(trackedObject, eventId) || !this.uniqueEvents)) {
    await setEventActive(trackedObject, eventId)
    // console.log(`${(new Date()).toUTCString()} - ${this.frigateCameraName} - ${trackedObject} - ${eventId} - ${JSON.stringify(event)}`)
    if(shouldThrottle()) {
      this.logger?.info({ camera: this.frigateCameraName, msg: 'Event ignored', trackedObject, id:eventId, reason: 'throttling'})
    } else {
      recordTriggerForThrottling()

      this.logger?.info({ camera: this.frigateCameraName, msg: 'Object detected', trackedObject, id:eventId})

      const snapshot = await this.homey.images.createImage()
      const thumbnail = await this.homey.images.createImage()

      if(event.after.has_snapshot) {
        await Promise.all([
          frigateAPI.getEventSnapshotImage({image: snapshot, frigateURL: this.frigateURL!, eventId}),
          frigateAPI.getEventThumbnailImage({image: thumbnail, frigateURL: this.frigateURL!, eventId})
        ])
      } else {
        snapshot.setPath(path.join(__dirname, '../../assets/images/placeholder_snapshot.jpg'));
        thumbnail.setPath(path.join(__dirname, '../../assets/images/placeholder_thumbnail.jpg'));
      }

      let clipURL:string = ''
      if(event.after.has_clip) {
        clipURL = `${this.frigateURL}/api/events/${eventId}/clip.mp4`
      }

      this.homey.flow.getDeviceTriggerCard('object-detected').trigger(this, {
        'object': trackedObject,
        'cameraName': event.after.camera,
        'snapshot': snapshot,
        'thumbnail': thumbnail,
        'clipURL': clipURL,
        'eventId': event.after.id,
        'current_zones': (event.after.current_zones || []).join(','),
        'entered_zones': (event.after.entered_zones || []).join(',')
      })

      this.homey.flow.getTriggerCard('all-cameras-object-detected').trigger({
        'object': trackedObject,
        'cameraName': event.after.camera,
        'snapshot': snapshot,
        'thumbnail': thumbnail,
        'clipURL': clipURL,
        'eventId': event.after.id,
        'current_zones': (event.after.current_zones || []).join(','),
        'entered_zones': (event.after.entered_zones || []).join(',')
      })
    }
  } else if(trackedObject && (event.type === 'end' || event.after.false_positive)) {
    this.logger?.info({camera: this.frigateCameraName, msg: 'Ending event', false_positive: event.after.false_positive, id: event.after.id})
    await this._setEventEnded(trackedObject, eventId)
  }
}