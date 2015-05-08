import readFile from "./readFile";
import * as async from "async";
let THREE = SupEngine.THREE;

let gltfConst = {
  UNSIGNED_SHORT: 5123,
  FLOAT: 5126
}

function convertAxisAngleToQuaternion(rotations: Float32Array, count: number) {
  let q = new THREE.Quaternion;
  let axis = new THREE.Vector3;
  let euler = new THREE.Vector3;

  for (let i = 0; i < count; i++) {
    axis.set(rotations[i * 4], rotations[i * 4 + 1], rotations[i * 4 + 2]).normalize();
    let angle = rotations[i * 4 + 3];
    q.setFromAxisAngle(axis, angle);
    rotations[i * 4] = q.x;
    rotations[i * 4 + 1] = q.y;
    rotations[i * 4 + 2] = q.z;
    rotations[i * 4 + 3] = q.w;
  }
}

export function importModel(files: File[], callback: (err: Error, result: any) => any) {
  let gltfFile: File = null;
  let bufferFiles: { [name: string]: File } = {};
  let imageFiles: { [name: string]: File } = {};
  let buffers: { [name: string]: ArrayBuffer } = {};

  for (let file of files) {
    let filename = file.name;
    let extension = filename.substring(filename.lastIndexOf(".") + 1).toLowerCase();

    switch(extension) {
      case "gltf":
        if (gltfFile != null) { callback(new Error("Cannot import multiple GLTF files at once"), null); return; }
        gltfFile = file;
        break;

      case "bin":
        bufferFiles[filename] = file;
        break;

      case "png":
      case "jpg":
        imageFiles[filename] = file;
        break;

      default:
        callback(new Error(`Unsupported file type: ${filename}`), null);
        return;
    }
  }

  let onGLTFRead = (err: Error, gltf: any) => {
    if (err != null) { callback(new Error("Could not parse GLTF file as JSON"), null); return; }
    if(Object.keys(gltf.meshes).length > 1) { callback(new Error("Only a single mesh is supported"), null); return; }

    let upAxisMatrix = new THREE.Matrix4;

    let rootNode = gltf.nodes[ gltf.scenes[gltf.scene].nodes[0] ];

    // Check if the model has its up-axis pointing in the wrong direction
    if(rootNode.name === "Y_UP_Transform") {
      upAxisMatrix.fromArray(rootNode.matrix);
      upAxisMatrix.getInverse(upAxisMatrix);
    }

    let meshName: string = null;
    let rootBoneNames: string[] = null;
    let skin: any = null;

    for (let childName of rootNode.children) {
      let node = gltf.nodes[childName];

      // FIXME: is it sometimes node.meshes?
      if(node.instanceSkin != null && node.instanceSkin.meshes != null && node.instanceSkin.meshes.length > 0) {
        meshName = node.instanceSkin.meshes[0];
        rootBoneNames = node.instanceSkin.skeletons;
        skin = gltf.skins[node.instanceSkin.skin];
        break;
      }
    }

    if (meshName == null) { callback(new Error("Couldn't find a mesh"), null); return; }

    let meshInfo = gltf.meshes[meshName];
    if (meshInfo.primitives.length !== 1) { callback(new Error("Only a single primitive is supported"), null); return; }
    if (meshInfo.primitives[0].primitive !== 4) { callback(new Error("Only triangles are supported"), null); return; }

    async.each(Object.keys(gltf.buffers), (name, cb) => {
      let bufferInfo = gltf.buffers[name];

      // Remove path info from the URI
      let filename = bufferInfo.uri;
      if (filename.indexOf("/") !== -1) filename = filename.substring(filename.lastIndexOf("/") + 1);
      else if (filename.indexOf("\\") !== -1) filename = filename.substring(filename.lastIndexOf("\\") + 1);

      let bufferFile = bufferFiles[filename];
      if (bufferFile == null) { cb(new Error(`Missing buffer file: ${filename}`)); return; }

      readFile(bufferFile, "arraybuffer", (err: Error, buffer: ArrayBuffer) => {
        if (err != null) { cb(err); return; }
        buffers[name] = buffer;
        cb();
      });
    }, (err: Error) => {
      if (err != null) { callback(err, null); return; }

      let primitive = meshInfo.primitives[0];
      let attributes: { [name: string]: ArrayBuffer } = {};

      // Indices
      let indexAccessor = gltf.accessors[primitive.indices];
      if (indexAccessor.componentType !== gltfConst.UNSIGNED_SHORT) {
        callback(new Error(`Unsupported component type for index accessor: ${indexAccessor.componentType}`), null);
        return;
      }

      {
        let indexBufferView = gltf.bufferViews[indexAccessor.bufferView];
        let start = indexBufferView.byteOffset + indexAccessor.byteOffset;
        attributes["index"] = buffers[indexBufferView.buffer].slice(start, start + indexAccessor.count * 2);
      }

      // Position
      let positionAccessor = gltf.accessors[primitive.attributes.POSITION];
      if (positionAccessor.componentType !== gltfConst.FLOAT) {
        callback(new Error(`Unsupported component type for position accessor: ${positionAccessor.componentType}`), null);
        return
      }

      {
        let positionBufferView = gltf.bufferViews[positionAccessor.bufferView];
        let start = positionBufferView.byteOffset + positionAccessor.byteOffset;
        let positionArray = new Float32Array(buffers[positionBufferView.buffer], start, positionAccessor.count * 3);

        for (let i = 0; i <positionAccessor.count; i++) {
          let pos = new THREE.Vector3(positionArray[i * 3 + 0], positionArray[i * 3 + 1], positionArray[i * 3 + 2]);
          pos.applyMatrix4(upAxisMatrix);
          positionArray[i * 3 + 0] = pos.x;
          positionArray[i * 3 + 1] = pos.y;
          positionArray[i * 3 + 2] = pos.z;
        }

        attributes["position"] = buffers[positionBufferView.buffer].slice(start, start + positionAccessor.count * positionAccessor.byteStride);
      }

      // Normal
      let normalAccessor = gltf.accessors[primitive.attributes.NORMAL];
      if (normalAccessor != null) {
        if(normalAccessor.componentType !== gltfConst.FLOAT) {
          callback(new Error(`Unsupported component type for normal accessor: ${normalAccessor.componentType}`), null);
          return;
        }

        let normalBufferView = gltf.bufferViews[normalAccessor.bufferView];
        let start = normalBufferView.byteOffset + normalAccessor.byteOffset;
        attributes["normal"] = buffers[normalBufferView.buffer].slice(start, start + normalAccessor.count * 4);
      }

      // UV
      let uvAccessor = gltf.accessors[primitive.attributes.TEXCOORD_0];
      if (uvAccessor != null) {
        if (uvAccessor.componentType !== gltfConst.FLOAT) {
          callback(new Error(`Unsupported component type for UV accessor: ${uvAccessor.componentType}`), null);
          return;
        }

        let uvBufferView = gltf.bufferViews[uvAccessor.bufferView];
        let start = uvBufferView.byteOffset + uvAccessor.byteOffset;
        let uvArray = new Float32Array(buffers[uvBufferView.buffer], start, uvAccessor.count * 2);

        for (let i = 0; i < uvAccessor.count; i++) {
          uvArray[i * 2 + 1] = 1 - uvArray[i * 2 + 1];
        }

        attributes["uv"] = buffers[uvBufferView.buffer].slice(start, start + uvAccessor.count * uvAccessor.byteStride);
      }

      // TODO: support more attributes

      // Skin indices
      let skinIndexAccessor = gltf.accessors[primitive.attributes.JOINT];
      if (skinIndexAccessor != null) {
        if (skinIndexAccessor.componentType !== gltfConst.FLOAT) {
          callback(new Error(`Unsupported component type for skin index accessor: ${skinIndexAccessor.componentType}`), null);
          return;
        }

        let skinIndexBufferView = gltf.bufferViews[skinIndexAccessor.bufferView];
        let start = skinIndexBufferView.byteOffset + skinIndexAccessor.byteOffset;
        attributes["skinIndex"] = buffers[skinIndexBufferView.buffer].slice(start, start + skinIndexAccessor.count * 4 * 4);
      }

      // Skin weights
      let skinWeightAccessor = gltf.accessors[primitive.attributes.WEIGHT];
      if (skinWeightAccessor != null) {
        if (skinWeightAccessor.componentType !== gltfConst.FLOAT) {
          callback(new Error(`Unsupported component type for skin weight accessor: ${skinWeightAccessor.componentType}`), null);
          return;
        }

        let skinWeightBufferView = gltf.bufferViews[skinWeightAccessor.bufferView];
        let start = skinWeightBufferView.byteOffset + skinWeightAccessor.byteOffset;
        attributes["skinWeight"] = buffers[skinWeightBufferView.buffer].slice(start, start + skinWeightAccessor.count * 4 * 4);
      }

      // Bones
      let bones: { name: string; matrix: number[]; parentIndex: number }[] = null;
      if (skin != null) {
        bones = [];

        // skin.inverseBindMatrices
        for (let i = 0; i < skin.jointNames.length; i++) {
          let jointName = skin.jointNames[i];
          let boneNodeInfo = gltf.nodes[jointName];

          if (boneNodeInfo.matrix == null) {
            convertAxisAngleToQuaternion(boneNodeInfo.rotation, 1);

            boneNodeInfo.matrix = new THREE.Matrix4().compose(
              new THREE.Vector3( boneNodeInfo.translation[0], boneNodeInfo.translation[1], boneNodeInfo.translation[2] ),
              new THREE.Quaternion( boneNodeInfo.rotation[0], boneNodeInfo.rotation[1], boneNodeInfo.rotation[2], boneNodeInfo.rotation[3] ),
              new THREE.Vector3( boneNodeInfo.scale[0], boneNodeInfo.scale[1], boneNodeInfo.scale[2] )
            ).toArray();
          }

          let bone = { name: boneNodeInfo.jointName, matrix: boneNodeInfo.matrix, parentIndex: <number>null };
          bones.push(bone);
        }

        for (let i = 0; i < skin.jointNames.length; i++) {
          let jointName = skin.jointNames[i];
          for (let childJointName of gltf.nodes[jointName].children) {
            bones[skin.jointNames.indexOf(childJointName)].parentIndex = i;
          }
        }

        let tmpMatrix = new THREE.Matrix4;
        for (let jointName of rootBoneNames) {
          let bone = bones[skin.jointNames.indexOf(jointName)];
          bone.matrix = tmpMatrix.fromArray(bone.matrix).multiplyMatrices(upAxisMatrix, tmpMatrix).toArray();
        }
      }

      // Animation
      let animation: { duration: number; keyFrames: { [jointName: string]: any } } = null;
      if (Object.keys(gltf.animations).length > 0) {
        animation = { duration: 0, keyFrames: {} };

        for (let gltfAnimName in gltf.animations) {
          let gltfAnim = gltf.animations[gltfAnimName];
          // gltfAnim.count = keyframe count

          // gltfAnim.channels gives bone name + path (scale, rotation, position)
          for (let gltfChannelName in gltfAnim.channels) {
            let gltfChannel = gltfAnim.channels[gltfChannelName];

            let jointName = gltfChannel.target.id;
            // TODO: get skin.jointNames.indexOf(jointName) and work with IDs instead of jointName?

            let boneAnim = animation.keyFrames[jointName];
            if (boneAnim == null) boneAnim = animation.keyFrames[jointName] = {};

            if (boneAnim[gltfChannel.target.path] != null) {
              callback(new Error(`Found multiple animations for ${gltfChannel.target.path} of ${jointName} bone`), null);
              return;
            }

            let boneTransformAnim = boneAnim[gltfChannel.target.path];
            if (boneTransformAnim == null) boneTransformAnim = boneAnim[gltfChannel.target.path] = [];

            let inputParameterName = gltfAnim.samplers[gltfChannel.sampler].input;
            let timeAccessor = gltf.accessors[gltfAnim.parameters[inputParameterName]];
            if (timeAccessor.componentType !== gltfConst.FLOAT) {
              callback(new Error(`Unsupported component type for animation time accessor: ${timeAccessor.componentType}`), null);
              return;
            }

            let timeBufferView = gltf.bufferViews[timeAccessor.bufferView];
            let timeArray = new Float32Array(buffers[timeBufferView.buffer], timeBufferView.byteOffset + timeAccessor.byteOffset, timeAccessor.count);

            let outputParameterName = gltfAnim.samplers[gltfChannel.sampler].output;
            let outputAccessor = gltf.accessors[gltfAnim.parameters[outputParameterName]];
            if (outputAccessor.componentType !== gltfConst.FLOAT) {
              callback(new Error(`Unsupported component type for animation output accessor: ${outputAccessor.componentType}`), null);
              return;
            }

            let componentsCount = (outputAccessor.type === "VEC3") ? 3 : 4;

            let outputBufferView = gltf.bufferViews[outputAccessor.bufferView];
            let outputArray = new Float32Array(buffers[outputBufferView.buffer], outputBufferView.byteOffset + outputAccessor.byteOffset, outputAccessor.count * componentsCount);

            if (outputParameterName === "rotation") {
              convertAxisAngleToQuaternion(outputArray, outputAccessor.count);
            }

            for (let i = 0; i < timeArray.length; i++) {
              let time = timeArray[i];

              let value: number[] = [];
              for (let j = 0; j < componentsCount; j++) value.push(outputArray[i * componentsCount + j]);
              boneTransformAnim.push({ time, value });
              animation.duration = Math.max(animation.duration, time);
            }
          }
        }
      }

      // Maps
      let maps: { [name: string]: ArrayBuffer } = {};

      if(Object.keys(imageFiles).length === 0) {
        callback(null, { attributes, bones, maps, animation });
        return;
      }

      readFile(imageFiles[Object.keys(imageFiles)[0]], "arraybuffer", (err, data) => {
        maps["diffuse"] = data;
        callback(null, { attributes, bones, maps, animation });
      });
    });
  }

  readFile(gltfFile, "json", onGLTFRead);
}
